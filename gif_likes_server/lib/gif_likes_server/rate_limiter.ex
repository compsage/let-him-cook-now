defmodule GifLikesServer.RateLimiter do
  @moduledoc """
  Rate Limiter - prevents abuse by limiting requests per client.

  ## How It Works

  We track request counts per client_id in ETS. Each entry looks like:
  ```
  {client_id, request_count, window_start_time}
  ```

  When a request comes in:
  1. Look up the client's current count and window start
  2. If we're in a new time window, reset the count
  3. If count < limit, allow the request and increment
  4. If count >= limit, reject the request

  ## Sliding Window vs Fixed Window

  This uses a "fixed window" approach - simpler but less precise.
  The window resets every minute on the minute boundary.

  For example, if limit is 20/minute:
  - At 12:00:59, client makes request #20 → allowed
  - At 12:01:00, window resets, count = 0
  - Client could make 20 more requests immediately

  A "sliding window" would be more accurate but more complex.
  For a likes server, fixed window is fine.

  ## Why ETS Instead of GenServer State?

  We COULD store counts in GenServer state, but ETS is better because:
  1. Concurrent reads - checking rate limits is fast
  2. Survives GenServer restart - if this crashes, we don't lose counts

  The GenServer here is mainly for:
  1. Periodic cleanup of old entries (prevent memory leak)
  2. Owning the ETS table (tables die with their owner process)
  """

  use GenServer
  require Logger

  # =============================================================================
  # CONFIGURATION
  # =============================================================================

  @ets_table :rate_limiter              # ETS table name
  @max_requests 20                       # Max requests per window
  @window_ms 60_000                      # Window size: 60 seconds (1 minute)
  @cleanup_interval_ms 60_000            # Clean up old entries every minute

  # =============================================================================
  # PUBLIC API
  # =============================================================================

  @doc """
  Start the rate limiter GenServer.
  """
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Check if a request is allowed for this client.

  Returns:
  - {:ok, remaining} - request allowed, `remaining` requests left in window
  - {:error, :rate_limited, retry_after_ms} - request denied, retry after N ms

  ## Example

  ```elixir
  case RateLimiter.check_rate("user123") do
    {:ok, remaining} ->
      # Process the request
      IO.puts("Allowed! \#{remaining} requests left")

    {:error, :rate_limited, retry_after} ->
      # Return 429 Too Many Requests
      IO.puts("Rate limited! Retry in \#{retry_after}ms")
  end
  ```
  """
  def check_rate(client_id) do
    now = System.monotonic_time(:millisecond)
    window_start = get_window_start(now)

    # Try to look up existing record for this client
    case :ets.lookup(@ets_table, client_id) do
      # No record exists - this is their first request
      [] ->
        # Insert new record with count = 1
        :ets.insert(@ets_table, {client_id, 1, window_start})
        {:ok, @max_requests - 1}

      # Record exists - check if same window or new window
      [{^client_id, count, record_window_start}] ->
        if record_window_start == window_start do
          # Same window - check if under limit
          if count < @max_requests do
            # Under limit - increment and allow
            :ets.update_counter(@ets_table, client_id, {2, 1})
            {:ok, @max_requests - count - 1}
          else
            # Over limit - deny
            retry_after = window_start + @window_ms - now
            {:error, :rate_limited, max(retry_after, 0)}
          end
        else
          # New window - reset count
          :ets.insert(@ets_table, {client_id, 1, window_start})
          {:ok, @max_requests - 1}
        end
    end
  end

  @doc """
  Get the current request count for a client (for debugging/stats).
  """
  def get_count(client_id) do
    now = System.monotonic_time(:millisecond)
    window_start = get_window_start(now)

    case :ets.lookup(@ets_table, client_id) do
      [] -> 0
      [{^client_id, count, record_window_start}] ->
        if record_window_start == window_start, do: count, else: 0
    end
  end

  @doc """
  Reset the rate limit for a client (for testing).
  """
  def reset(client_id) do
    :ets.delete(@ets_table, client_id)
    :ok
  end

  @doc """
  Get stats about the rate limiter.
  """
  def stats do
    %{
      active_clients: :ets.info(@ets_table, :size),
      max_requests: @max_requests,
      window_seconds: div(@window_ms, 1000)
    }
  end

  # =============================================================================
  # GENSERVER CALLBACKS
  # =============================================================================

  @impl true
  def init(_opts) do
    Logger.info("Initializing rate limiter (#{@max_requests} requests per #{div(@window_ms, 1000)} seconds)")

    # Create ETS table
    # Options:
    # - :set - one entry per key
    # - :named_table - can reference by name
    # - :public - any process can read/write
    # - {:write_concurrency, true} - optimize for concurrent writes
    :ets.new(@ets_table, [
      :set,
      :named_table,
      :public,
      {:write_concurrency, true}
    ])

    # Schedule periodic cleanup
    schedule_cleanup()

    {:ok, %{cleanup_count: 0}}
  end

  @doc """
  Periodic cleanup - remove entries from expired windows.

  Without this, ETS would grow forever as new clients make requests.
  We remove entries older than 2 windows (to be safe).
  """
  @impl true
  def handle_info(:cleanup, state) do
    now = System.monotonic_time(:millisecond)
    cutoff = get_window_start(now) - @window_ms  # One window ago

    # Count entries before cleanup
    before_count = :ets.info(@ets_table, :size)

    # Delete entries with window_start older than cutoff
    # :ets.select_delete uses a "match spec" - a pattern to match entries
    # This is like a WHERE clause in SQL
    :ets.select_delete(@ets_table, [
      {
        {:"$1", :"$2", :"$3"},           # Match pattern: {client_id, count, window_start}
        [{:<, :"$3", cutoff}],            # Guard: window_start < cutoff
        [true]                            # Return true (delete this entry)
      }
    ])

    after_count = :ets.info(@ets_table, :size)
    deleted = before_count - after_count

    if deleted > 0 do
      Logger.debug("Rate limiter cleanup: removed #{deleted} expired entries")
    end

    # Schedule next cleanup
    schedule_cleanup()

    {:noreply, %{state | cleanup_count: state.cleanup_count + 1}}
  end

  # =============================================================================
  # PRIVATE FUNCTIONS
  # =============================================================================

  @doc false
  defp get_window_start(now) do
    # Round down to nearest window boundary
    # For example, if window is 60 seconds and now is 12:34:56,
    # window_start would be 12:34:00
    div(now, @window_ms) * @window_ms
  end

  @doc false
  defp schedule_cleanup do
    Process.send_after(self(), :cleanup, @cleanup_interval_ms)
  end
end
