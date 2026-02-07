# Building a Likes Server in Elixir

A complete guide to building a lightweight key-value likes server using Elixir, ETS, and async disk persistence.

---

## Table of Contents

1. [Overview](#overview)
2. [Project Structure](#project-structure)
3. [Core Concepts](#core-concepts)
4. [Implementation](#implementation)
5. [GenServer Patterns](#genserver-patterns)
6. [BEAM Deep Dive](#beam-deep-dive)
7. [Running & Testing](#running--testing)

---

## Overview

### What We're Building

A lightweight HTTP server that:
- Tracks "likes" for items (articles, photos, etc.)
- Stores data as key-value pairs: `item_name → set of client IDs`
- Supports CRUD operations + like toggling
- Uses ETS for fast in-memory storage
- Async writes to disk (DETS) for persistence

### Tech Stack

| Component | Purpose |
|-----------|---------|
| Plug + Cowboy | Lightweight HTTP server |
| ETS | In-memory key-value storage |
| DETS | Disk persistence |
| GenServer | State management + async sync |
| Jason | JSON encoding/decoding |

### Data Structure

```elixir
%{
  "article-1" => MapSet.new(["user123", "192.168.1.1", "alice"]),
  "article-2" => MapSet.new(["bob"]),
  "cool-photo" => MapSet.new([])
}
```

---

## Project Structure

```
likes_server/
├── mix.exs                    # Project definition
├── lib/
│   ├── likes_server.ex        # Application entry point
│   └── likes_server/
│       ├── store.ex           # ETS + DETS storage
│       └── router.ex          # HTTP endpoints
└── data/
    └── likes_store.dets       # Persistent storage (auto-created)
```

---

## Core Concepts

### Elixir Basics

```elixir
# Modules
defmodule MyModule do
  def public_function, do: "anyone can call"
  defp private_function, do: "only this module"
end

# Pattern Matching
{:ok, result} = {:ok, 42}        # result = 42
[head | tail] = [1, 2, 3]        # head = 1, tail = [2, 3]

# Pipe Operator
"hello" |> String.upcase() |> String.reverse()  # "OLLEH"

# Maps
map = %{"key" => "value"}
Map.get(map, "key")              # "value"
Map.put(map, "new", "data")      # returns NEW map

# MapSet (unique values)
set = MapSet.new(["a", "b"])
MapSet.put(set, "c")             # MapSet.new(["a", "b", "c"])
MapSet.member?(set, "a")         # true
```

### ETS vs GenServer State

| Aspect | GenServer State | ETS |
|--------|-----------------|-----|
| Concurrency | Serialized (one at a time) | Concurrent reads |
| Speed | ~10K ops/sec | ~1M ops/sec |
| Memory | In process heap | Separate memory |
| Persistence | Lost on crash | Survives process crash |

**Use ETS for storage, GenServer for coordination.**

### When to Use GenServer

Ask: **"Do I need to remember something between requests?"**

| Pattern | Use Case |
|---------|----------|
| Counter | Count things across requests |
| Cache | Remember expensive computations |
| Registry | Track active users/connections |
| Queue/Buffer | Batch writes, email queues |
| Rate Limiter | Limit requests per time window |
| Periodic Worker | Scheduled tasks, cleanup |

---

## Implementation

### mix.exs

```elixir
defmodule LikesServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :likes_server,
      version: "0.1.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {LikesServer, []}
    ]
  end

  defp deps do
    [
      {:plug_cowboy, "~> 2.6"},
      {:jason, "~> 1.4"}
    ]
  end
end
```

### lib/likes_server.ex

```elixir
defmodule LikesServer do
  @moduledoc """
  Application entry point.
  Starts supervision tree with Store and web server.
  """
  
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      LikesServer.Store,
      {Plug.Cowboy, 
        scheme: :http, 
        plug: LikesServer.Router, 
        options: [port: 4000]}
    ]

    opts = [strategy: :one_for_one, name: LikesServer.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

### lib/likes_server/store.ex

```elixir
defmodule LikesServer.Store do
  @moduledoc """
  ETS-based store with async DETS persistence.
  
  Architecture:
  - ETS for fast reads/writes (in-memory)
  - DETS for persistence (on disk)
  - Periodic sync: ETS → DETS every N seconds
  - On startup: DETS → ETS (restore state)
  - On shutdown: final ETS → DETS sync
  """

  use GenServer
  require Logger

  @ets_table :likes_store
  @dets_table :likes_store_disk
  @sync_interval_ms 5_000
  @data_dir "data"
  @dets_file ~c"data/likes_store.dets"

  # ===========================================================================
  # PUBLIC API
  # ===========================================================================

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Get all items as a map"
  def all do
    @ets_table
    |> :ets.tab2list()
    |> Map.new()
  end

  @doc "Get likes for a specific item"
  def get(item) do
    case :ets.lookup(@ets_table, item) do
      [{^item, likes}] -> likes
      [] -> nil
    end
  end

  @doc "Create an item with zero likes"
  def create(item) do
    case :ets.insert_new(@ets_table, {item, MapSet.new()}) do
      true ->
        GenServer.cast(__MODULE__, {:mark_dirty, item})
        true
      false ->
        false
    end
  end

  @doc "Delete an item"
  def delete(item) do
    :ets.delete(@ets_table, item)
    GenServer.cast(__MODULE__, {:mark_deleted, item})
    :ok
  end

  @doc "Toggle a like (atomic via GenServer)"
  def toggle_like(item, client_id) do
    GenServer.call(__MODULE__, {:toggle, item, client_id})
  end

  @doc "Check if client has liked an item"
  def liked?(item, client_id) do
    case get(item) do
      nil -> false
      likes -> MapSet.member?(likes, client_id)
    end
  end

  @doc "Force immediate sync to disk"
  def sync_now do
    GenServer.call(__MODULE__, :sync_now)
  end

  @doc "Get sync stats"
  def stats do
    GenServer.call(__MODULE__, :stats)
  end

  # ===========================================================================
  # GENSERVER CALLBACKS
  # ===========================================================================

  @impl true
  def init(_opts) do
    # Ensure data directory exists
    File.mkdir_p!(@data_dir)
    
    # Open DETS file
    {:ok, _dets} = :dets.open_file(@dets_table, [
      {:file, @dets_file},
      {:type, :set}
    ])
    
    # Create ETS table
    :ets.new(@ets_table, [
      :set,
      :named_table,
      :public,
      {:read_concurrency, true}
    ])
    
    # Restore data from DETS into ETS
    restored_count = restore_from_disk()
    Logger.info("Restored #{restored_count} items from disk")
    
    # Schedule first sync
    schedule_sync()
    
    state = %{
      dirty_keys: MapSet.new(),
      deleted_keys: MapSet.new(),
      last_sync: nil,
      sync_count: 0
    }
    
    {:ok, state}
  end

  @impl true
  def handle_call({:toggle, item, client_id}, _from, state) do
    result = do_toggle(item, client_id)
    new_dirty = MapSet.put(state.dirty_keys, item)
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

  @impl true
  def handle_cast({:mark_dirty, key}, state) do
    {:noreply, %{state | dirty_keys: MapSet.put(state.dirty_keys, key)}}
  end

  @impl true
  def handle_cast({:mark_deleted, key}, state) do
    new_state = %{state |
      dirty_keys: MapSet.delete(state.dirty_keys, key),
      deleted_keys: MapSet.put(state.deleted_keys, key)
    }
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:sync, state) do
    new_state = 
      if MapSet.size(state.dirty_keys) > 0 or MapSet.size(state.deleted_keys) > 0 do
        do_sync(state)
      else
        state
      end
    
    schedule_sync()
    {:noreply, new_state}
  end

  @impl true
  def terminate(reason, state) do
    Logger.info("Store shutting down (#{inspect(reason)}), final sync...")
    do_sync(state)
    :dets.close(@dets_table)
    :ok
  end

  # ===========================================================================
  # PRIVATE FUNCTIONS
  # ===========================================================================

  defp do_toggle(item, client_id) do
    case :ets.lookup(@ets_table, item) do
      [] ->
        :ets.insert(@ets_table, {item, MapSet.new([client_id])})
        :added

      [{^item, likes}] ->
        if MapSet.member?(likes, client_id) do
          :ets.insert(@ets_table, {item, MapSet.delete(likes, client_id)})
          :removed
        else
          :ets.insert(@ets_table, {item, MapSet.put(likes, client_id)})
          :added
        end
    end
  end

  defp restore_from_disk do
    :dets.foldl(
      fn {key, value}, acc ->
        :ets.insert(@ets_table, {key, value})
        acc + 1
      end,
      0,
      @dets_table
    )
  end

  defp do_sync(state) do
    start_time = System.monotonic_time(:millisecond)
    
    # Write dirty keys
    dirty_count = state.dirty_keys
    |> Enum.reduce(0, fn key, count ->
      case :ets.lookup(@ets_table, key) do
        [{^key, value}] ->
          :dets.insert(@dets_table, {key, value})
          count + 1
        [] ->
          count
      end
    end)
    
    # Delete removed keys
    delete_count = state.deleted_keys
    |> Enum.reduce(0, fn key, count ->
      :dets.delete(@dets_table, key)
      count + 1
    end)
    
    :dets.sync(@dets_table)
    
    duration = System.monotonic_time(:millisecond) - start_time
    
    if dirty_count > 0 or delete_count > 0 do
      Logger.debug("Synced #{dirty_count} writes, #{delete_count} deletes in #{duration}ms")
    end
    
    %{state |
      dirty_keys: MapSet.new(),
      deleted_keys: MapSet.new(),
      last_sync: DateTime.utc_now(),
      sync_count: state.sync_count + 1
    }
  end

  defp schedule_sync do
    Process.send_after(self(), :sync, @sync_interval_ms)
  end
end
```

### lib/likes_server/router.ex

```elixir
defmodule LikesServer.Router do
  @moduledoc """
  HTTP router using Plug.
  """
  
  use Plug.Router

  plug :match
  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  plug :dispatch

  # GET / - List all items
  get "/" do
    data = 
      LikesServer.Store.all()
      |> Enum.map(fn {item, likes} ->
        %{
          item: item, 
          count: MapSet.size(likes), 
          clients: MapSet.to_list(likes)
        }
      end)
      |> Enum.sort_by(& &1.item)

    json(conn, 200, data)
  end

  # GET /items/:item - Get specific item
  get "/items/:item" do
    case LikesServer.Store.get(item) do
      nil ->
        json(conn, 404, %{error: "not found", item: item})

      likes ->
        json(conn, 200, %{
          item: item,
          count: MapSet.size(likes),
          clients: MapSet.to_list(likes)
        })
    end
  end

  # POST /items/:item - Create item
  post "/items/:item" do
    case LikesServer.Store.create(item) do
      true ->
        json(conn, 201, %{item: item, count: 0, clients: [], created: true})
      
      false ->
        likes = LikesServer.Store.get(item)
        json(conn, 200, %{
          item: item, 
          count: MapSet.size(likes), 
          clients: MapSet.to_list(likes),
          created: false
        })
    end
  end

  # DELETE /items/:item - Delete item
  delete "/items/:item" do
    LikesServer.Store.delete(item)
    json(conn, 200, %{deleted: item})
  end

  # POST /items/:item/like - Toggle like
  post "/items/:item/like" do
    client_id = get_client_id(conn)
    action = LikesServer.Store.toggle_like(item, client_id)
    likes = LikesServer.Store.get(item)

    json(conn, 200, %{
      item: item,
      action: action,
      client: client_id,
      count: MapSet.size(likes),
      liked: action == :added
    })
  end

  # GET /items/:item/liked - Check if liked
  get "/items/:item/liked" do
    client_id = get_client_id(conn)
    
    case LikesServer.Store.get(item) do
      nil ->
        json(conn, 404, %{error: "not found", item: item})
      
      _likes ->
        liked = LikesServer.Store.liked?(item, client_id)
        json(conn, 200, %{item: item, client: client_id, liked: liked})
    end
  end

  # GET /stats - Get store stats
  get "/stats" do
    stats = LikesServer.Store.stats()
    json(conn, 200, stats)
  end

  # POST /sync - Force sync
  post "/sync" do
    LikesServer.Store.sync_now()
    json(conn, 200, %{synced: true})
  end

  match _ do
    json(conn, 404, %{error: "not found"})
  end

  # Helpers

  defp json(conn, status, data) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(data))
  end

  defp get_client_id(conn) do
    cond do
      id = get_req_header(conn, "x-client-id") |> List.first() -> id
      id = conn.params["client_id"] -> id
      true -> format_ip(conn.remote_ip)
    end
  end

  defp format_ip({a, b, c, d}), do: "#{a}.#{b}.#{c}.#{d}"
  defp format_ip(ip), do: inspect(ip)
end
```

---

## GenServer Patterns

### How GenServer Works

```
┌─────────────────┐                      ┌─────────────────┐
│   Your Code     │                      │   GenServer     │
│                 │    GenServer.call    │                 │
│                 │ ──────────────────▶  │   ┌─────────┐   │
│   waiting...    │                      │   │ Mailbox │   │
│                 │                      │   └────┬────┘   │
│                 │                      │        ▼        │
│                 │                      │  handle_call()  │
│                 │    {:reply, result}  │        │        │
│                 │ ◀──────────────────  │        │        │
│   continues     │                      │                 │
└─────────────────┘                      └─────────────────┘
```

### Key Callbacks

| Callback | Triggered By | Returns |
|----------|--------------|---------|
| `init/1` | `start_link` | `{:ok, state}` |
| `handle_call/3` | `GenServer.call` (sync) | `{:reply, response, new_state}` |
| `handle_cast/2` | `GenServer.cast` (async) | `{:noreply, new_state}` |
| `handle_info/2` | Raw messages, timers | `{:noreply, new_state}` |
| `terminate/2` | Shutdown | `:ok` |

### Common Patterns

```elixir
# Pattern 1: Counter
def handle_call(:increment, _from, count) do
  {:reply, count + 1, count + 1}
end

# Pattern 2: Periodic Task
def init(_) do
  schedule_work()
  {:ok, %{}}
end

def handle_info(:work, state) do
  do_work()
  schedule_work()
  {:noreply, state}
end

defp schedule_work do
  Process.send_after(self(), :work, 5_000)
end

# Pattern 3: Dirty Tracking
def handle_call({:update, key, value}, _from, state) do
  # Update ETS
  :ets.insert(@table, {key, value})
  # Mark dirty for later sync
  {:reply, :ok, %{state | dirty: MapSet.put(state.dirty, key)}}
end
```

---

## BEAM Deep Dive

### What Makes BEAM Special

| Aspect | OS Threads | BEAM Processes |
|--------|-----------|----------------|
| Memory | ~1 MB each | ~3 KB each |
| Creation | ~1 ms | ~1-3 μs |
| Max count | Thousands | Millions |
| Shared state | Yes (need locks) | No (messages only) |
| GC | Global (stop world) | Per-process |

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BEAM VM                                 │
│                                                                 │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│   │ Scheduler 1 │ │ Scheduler 2 │ │ Scheduler 3 │ ...          │
│   │ (OS thread) │ │ (OS thread) │ │ (OS thread) │              │
│   │             │ │             │ │             │              │
│   │ ┌───┐ ┌───┐ │ │ ┌───┐ ┌───┐ │ │ ┌───┐ ┌───┐ │              │
│   │ │ P │ │ P │ │ │ │ P │ │ P │ │ │ │ P │ │ P │ │              │
│   │ └───┘ └───┘ │ │ └───┘ └───┘ │ │ └───┘ └───┘ │              │
│   │    ...      │ │    ...      │ │    ...      │              │
│   └─────────────┘ └─────────────┘ └─────────────┘              │
│                                                                 │
│   Shared: [Atom Table] [Binary Heap] [ETS Tables]              │
└─────────────────────────────────────────────────────────────────┘
```

### Key Concepts

**Preemptive Scheduling**: Every ~4000 "reductions" (function calls), a process yields. No process can hog the CPU.

**Isolated Memory**: Each process has its own heap. GC is per-process (microseconds, not milliseconds).

**Message Passing**: Data is COPIED between processes. No shared mutable state = no locks needed.

**Work Stealing**: Idle schedulers steal work from busy ones. Automatic load balancing.

### Why "Process Per Entity" Works

```
Traditional:  10,000 threads × 1 MB = 10 GB RAM + lock hell
BEAM:         10,000 processes × 3 KB = 30 MB RAM + no locks
```

---

## Running & Testing

### Setup

```bash
# Create project
mix new likes_server --sup
cd likes_server

# Add dependencies to mix.exs, then:
mix deps.get

# Run
iex -S mix
```

### API Examples

```bash
# Create item
curl -X POST http://localhost:4000/items/my-article

# Toggle like (uses IP as client ID)
curl -X POST http://localhost:4000/items/my-article/like

# Toggle like with custom client ID
curl -X POST "http://localhost:4000/items/my-article/like?client_id=alice"

# Get item
curl http://localhost:4000/items/my-article

# List all
curl http://localhost:4000/

# Check if liked
curl "http://localhost:4000/items/my-article/liked?client_id=alice"

# Delete item
curl -X DELETE http://localhost:4000/items/my-article

# Get stats
curl http://localhost:4000/stats

# Force sync
curl -X POST http://localhost:4000/sync
```

### IEx Commands

```elixir
# See all data
LikesServer.Store.all()

# Manual operations
LikesServer.Store.create("test")
LikesServer.Store.toggle_like("test", "alice")
LikesServer.Store.get("test")

# Check ETS directly
:ets.tab2list(:likes_store)

# Check stats
LikesServer.Store.stats()

# Force sync
LikesServer.Store.sync_now()

# Observer (GUI)
:observer.start()
```

### Testing Persistence

```bash
# 1. Add some data
curl -X POST http://localhost:4000/items/test-article
curl -X POST "http://localhost:4000/items/test-article/like?client_id=alice"

# 2. Check stats (should show pending writes)
curl http://localhost:4000/stats

# 3. Wait 5 seconds (auto-sync) or force sync
curl -X POST http://localhost:4000/sync

# 4. Restart the server (Ctrl+C twice, then iex -S mix)

# 5. Data should still be there!
curl http://localhost:4000/items/test-article
```

---

## Quick Reference

### ETS Cheat Sheet

```elixir
# Create
:ets.new(:table, [:set, :named_table, :public])

# Write
:ets.insert(:table, {"key", "value"})
:ets.insert_new(:table, {"key", "value"})  # Only if missing

# Read
:ets.lookup(:table, "key")  # => [{"key", "value"}] or []
:ets.tab2list(:table)       # => all entries

# Delete
:ets.delete(:table, "key")
```

### DETS Cheat Sheet

```elixir
# Open
{:ok, table} = :dets.open_file(:table, [{:file, ~c"path.dets"}])

# Same API as ETS
:dets.insert(:table, {"key", "value"})
:dets.lookup(:table, "key")

# Sync to disk
:dets.sync(:table)

# Close
:dets.close(:table)
```

### GenServer Cheat Sheet

```elixir
# Start
GenServer.start_link(Module, args, name: Name)

# Sync call (blocks)
GenServer.call(Name, message)

# Async cast (fire-and-forget)
GenServer.cast(Name, message)

# Schedule message
Process.send_after(self(), :message, milliseconds)
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| ETS over Agent | Concurrent reads, much faster |
| GenServer for writes | Atomic toggle operations |
| Incremental sync | Only write changes, not entire table |
| 5-second sync interval | Balance between durability and performance |
| MapSet for likes | O(1) membership checks, no duplicates |
| DETS for persistence | Built-in, simple, good enough for this use case |

### Trade-offs

| Aspect | Current Choice | Alternative |
|--------|----------------|-------------|
| Storage | ETS + DETS | SQLite, PostgreSQL |
| Sync | Periodic (5s) | Write-through (immediate) |
| Architecture | Single GenServer | Process per item |

For higher scale, consider:
- Process per item (if items have complex state)
- Redis/PostgreSQL (if need distribution)
- Broadway (if need event processing)

---

## Further Reading

- [Elixir Getting Started](https://elixir-lang.org/getting-started/introduction.html)
- [GenServer Docs](https://hexdocs.pm/elixir/GenServer.html)
- [ETS Docs](https://www.erlang.org/doc/man/ets.html)
- [Plug Docs](https://hexdocs.pm/plug/readme.html)
- [BEAM Book](https://blog.stenmans.org/theBeamBook/)