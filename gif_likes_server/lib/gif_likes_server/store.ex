defmodule GifLikesServer.Store do
  @moduledoc """
  The Store module - manages likes data using ETS with DETS persistence.

  ## What is ETS?

  ETS (Erlang Term Storage) is an in-memory key-value store built into the BEAM.
  Think of it like Redis, but built into your language runtime.

  Key properties:
  - FAST: ~1 million operations per second
  - Concurrent reads: multiple processes can read simultaneously
  - Survives process crashes: data lives in a separate memory space

  ## What is DETS?

  DETS (Disk-based ETS) is the persistent version - it saves to disk.
  It's slower than ETS, so we use both:
  - ETS for fast reads/writes (in memory)
  - DETS for persistence (on disk)
  - Periodic sync: ETS → DETS every few seconds

  ## Data Structure

  We store likes as:
  ```
  gif_name => MapSet of client_ids
  ```

  For example:
  ```elixir
  %{
    "funny-cat.gif" => MapSet.new(["user123", "user456"]),
    "dancing-dog.gif" => MapSet.new(["user789"])
  }
  ```

  MapSet is like a Set in JavaScript - it only stores unique values
  and has O(1) membership checks.

  ## Why GenServer?

  We use GenServer (a "Generic Server") for two reasons:
  1. Atomic operations: toggle_like needs to read-then-write atomically
  2. Periodic tasks: we schedule syncs to DETS every N seconds

  The GenServer ensures only one operation happens at a time for writes,
  while ETS allows concurrent reads from any process.
  """

  use GenServer
  require Logger

  # =============================================================================
  # CONFIGURATION
  # =============================================================================
  # These module attributes (like constants) configure our store.
  # The @ symbol defines a compile-time constant.

  @ets_table :gif_likes_store           # Name for our ETS table
  @dets_table :gif_likes_store_disk     # Name for our DETS file
  @sync_interval_ms 5_000               # Sync to disk every 5 seconds
  @data_dir "data"                      # Directory for DETS file
  @dets_file ~c"data/gif_likes.dets"    # Path to DETS file (charlist for Erlang)

  # =============================================================================
  # PUBLIC API
  # =============================================================================
  # These functions are what other modules call. They're the "interface" to our store.
  # Notice how they either read directly from ETS (fast!) or delegate to GenServer
  # for operations that need coordination.

  @doc """
  Starts the Store GenServer. Called by the supervisor.

  ## What is start_link?

  `start_link` starts a new process and LINKS it to the calling process.
  "Linking" means if one dies, the other is notified (and may die too).
  This is how supervisors know when to restart children.

  The `name: __MODULE__` option registers this process globally by its module name,
  so we can call `GenServer.call(GifLikesServer.Store, ...)` from anywhere.
  """
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Get all items as a map. Reads directly from ETS (no GenServer needed).

  ## Pattern Explanation

  ```elixir
  @ets_table
  |> :ets.tab2list()    # Get all {key, value} tuples as a list
  |> Map.new()          # Convert list of tuples to a map
  ```

  The |> is the "pipe operator" - it passes the left side as the first
  argument to the function on the right. Like Unix pipes!
  """
  def all do
    @ets_table
    |> :ets.tab2list()
    |> Map.new()
  end

  @doc """
  Get the set of client IDs who liked a specific GIF.
  Returns nil if the GIF doesn't exist, or a MapSet of client IDs.

  ## Pattern Matching Example

  ```elixir
  case :ets.lookup(@ets_table, gif_name) do
    [{^gif_name, likes}] -> likes    # Found it! Return the likes
    [] -> nil                         # Empty list = not found
  end
  ```

  The `^` (pin operator) means "match this exact value, don't rebind".
  Without it, gif_name would be rebound to whatever key was found.
  """
  def get(gif_name) do
    case :ets.lookup(@ets_table, gif_name) do
      [{^gif_name, likes}] -> likes
      [] -> nil
    end
  end

  @doc """
  Toggle a like - this is the main operation!

  If client hasn't liked the GIF → add their ID (returns :added)
  If client already liked it → remove their ID (returns :removed)

  This MUST go through GenServer because it's a read-modify-write operation.
  If two requests came in simultaneously without GenServer, we could have a race condition.

  ## GenServer.call vs GenServer.cast

  - `call` is synchronous - waits for a response (used here because we need the result)
  - `cast` is async - fire and forget (used for marking dirty keys)
  """
  def toggle_like(gif_name, client_id) do
    GenServer.call(__MODULE__, {:toggle, gif_name, client_id})
  end

  @doc """
  Check if a client has liked a GIF. Read-only, so direct ETS access is fine.
  """
  def liked?(gif_name, client_id) do
    case get(gif_name) do
      nil -> false
      likes -> MapSet.member?(likes, client_id)
    end
  end

  @doc """
  Force an immediate sync to disk. Useful for testing or before shutdown.
  """
  def sync_now do
    GenServer.call(__MODULE__, :sync_now)
  end

  @doc """
  Get statistics about the store (for debugging/monitoring).
  """
  def stats do
    GenServer.call(__MODULE__, :stats)
  end

  # =============================================================================
  # GENSERVER CALLBACKS
  # =============================================================================
  # These are called by the GenServer behavior. They handle initialization,
  # incoming calls/casts, and scheduled messages.

  @doc """
  Initialize the store. Called once when the GenServer starts.

  ## What happens here:
  1. Create the data directory if it doesn't exist
  2. Open the DETS file (creates it if needed)
  3. Create the ETS table
  4. Restore any data from DETS into ETS
  5. Schedule the first periodic sync
  6. Return the initial state
  """
  @impl true
  def init(_opts) do
    Logger.info("Initializing GIF likes store...")

    # Ensure the data directory exists
    File.mkdir_p!(@data_dir)

    # Open DETS file for persistence
    # :dets.open_file returns {:ok, table_name} on success
    {:ok, _dets} = :dets.open_file(@dets_table, [
      {:file, @dets_file},  # Where to save the file
      {:type, :set}         # Each key can only appear once
    ])

    # Create ETS table for fast in-memory access
    # Options:
    # - :set - each key appears once (like a hash map)
    # - :named_table - we can refer to it by name (@ets_table)
    # - :public - any process can read/write (we control writes via GenServer)
    # - {:read_concurrency, true} - optimize for concurrent reads
    :ets.new(@ets_table, [
      :set,
      :named_table,
      :public,
      {:read_concurrency, true}
    ])

    # Restore data from disk into memory
    restored_count = restore_from_disk()
    Logger.info("Restored #{restored_count} GIF entries from disk")

    # Schedule the first sync (will repeat every @sync_interval_ms)
    schedule_sync()

    # Our GenServer state tracks:
    # - dirty_keys: keys that need to be synced to DETS
    # - deleted_keys: keys that need to be removed from DETS
    # - last_sync: when we last synced (for stats)
    # - sync_count: how many syncs we've done (for stats)
    state = %{
      dirty_keys: MapSet.new(),
      deleted_keys: MapSet.new(),
      last_sync: nil,
      sync_count: 0
    }

    {:ok, state}
  end

  @doc """
  Handle the toggle_like call. This is where the magic happens!

  ## The {:toggle, gif_name, client_id} message

  When someone calls `toggle_like(gif_name, client_id)`, GenServer translates
  that into a message `{:toggle, gif_name, client_id}` sent to our process.

  We pattern match on that message here.

  ## Return value

  `{:reply, result, new_state}` means:
  - Send `result` back to the caller
  - Update our state to `new_state`
  """
  @impl true
  def handle_call({:toggle, gif_name, client_id}, _from, state) do
    # do_toggle performs the actual toggle and returns :added or :removed
    result = do_toggle(gif_name, client_id)

    # Mark this key as "dirty" - needs to be synced to disk
    new_dirty = MapSet.put(state.dirty_keys, gif_name)

    {:reply, result, %{state | dirty_keys: new_dirty}}
  end

  @impl true
  def handle_call(:sync_now, _from, state) do
    new_state = do_sync(state)
    {:reply, :ok, new_state}
  end

  @impl true
  def handle_call(:stats, _from, state) do
    stats = %{
      items: :ets.info(@ets_table, :size),
      pending_writes: MapSet.size(state.dirty_keys),
      pending_deletes: MapSet.size(state.deleted_keys),
      last_sync: state.last_sync,
      sync_count: state.sync_count
    }
    {:reply, stats, state}
  end

  @doc """
  Handle the periodic :sync message.

  ## handle_info vs handle_call/handle_cast

  - handle_call: synchronous messages (GenServer.call)
  - handle_cast: async messages (GenServer.cast)
  - handle_info: everything else (timers, raw messages)

  We use Process.send_after to schedule a :sync message to ourselves.
  """
  @impl true
  def handle_info(:sync, state) do
    # Only sync if there's something to sync
    new_state =
      if MapSet.size(state.dirty_keys) > 0 or MapSet.size(state.deleted_keys) > 0 do
        do_sync(state)
      else
        state
      end

    # Schedule the next sync
    schedule_sync()

    {:noreply, new_state}
  end

  @doc """
  Called when the GenServer is shutting down. Do a final sync to not lose data.
  """
  @impl true
  def terminate(reason, state) do
    Logger.info("Store shutting down (#{inspect(reason)}), final sync...")
    do_sync(state)
    :dets.close(@dets_table)
    :ok
  end

  # =============================================================================
  # PRIVATE FUNCTIONS
  # =============================================================================
  # These are internal helpers. The `defp` keyword makes them private.

  @doc false
  defp do_toggle(gif_name, client_id) do
    case :ets.lookup(@ets_table, gif_name) do
      # GIF doesn't exist yet - create it with this client as first liker
      [] ->
        :ets.insert(@ets_table, {gif_name, MapSet.new([client_id])})
        :added

      # GIF exists - check if client already liked it
      [{^gif_name, likes}] ->
        if MapSet.member?(likes, client_id) do
          # Already liked - remove the like
          :ets.insert(@ets_table, {gif_name, MapSet.delete(likes, client_id)})
          :removed
        else
          # Not liked yet - add the like
          :ets.insert(@ets_table, {gif_name, MapSet.put(likes, client_id)})
          :added
        end
    end
  end

  @doc false
  defp restore_from_disk do
    # :dets.foldl iterates over all entries in DETS
    # It's like Array.reduce in JavaScript
    :dets.foldl(
      fn {key, value}, count ->
        :ets.insert(@ets_table, {key, value})
        count + 1
      end,
      0,  # Initial accumulator
      @dets_table
    )
  end

  @doc false
  defp do_sync(state) do
    start_time = System.monotonic_time(:millisecond)

    # Write all dirty keys to DETS
    dirty_count =
      state.dirty_keys
      |> Enum.reduce(0, fn key, count ->
        case :ets.lookup(@ets_table, key) do
          [{^key, value}] ->
            :dets.insert(@dets_table, {key, value})
            count + 1
          [] ->
            count
        end
      end)

    # Delete removed keys from DETS
    delete_count =
      state.deleted_keys
      |> Enum.reduce(0, fn key, count ->
        :dets.delete(@dets_table, key)
        count + 1
      end)

    # Force DETS to write to disk
    :dets.sync(@dets_table)

    duration = System.monotonic_time(:millisecond) - start_time

    if dirty_count > 0 or delete_count > 0 do
      Logger.debug("Synced #{dirty_count} writes, #{delete_count} deletes in #{duration}ms")
    end

    # Return new state with cleared dirty/deleted sets
    %{state |
      dirty_keys: MapSet.new(),
      deleted_keys: MapSet.new(),
      last_sync: DateTime.utc_now(),
      sync_count: state.sync_count + 1
    }
  end

  @doc false
  defp schedule_sync do
    # Send ourselves a :sync message after @sync_interval_ms milliseconds
    # This is how we implement periodic tasks in Elixir
    Process.send_after(self(), :sync, @sync_interval_ms)
  end
end
