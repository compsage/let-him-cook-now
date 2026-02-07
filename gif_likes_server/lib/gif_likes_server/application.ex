defmodule GifLikesServer.Application do
  @moduledoc """
  The Application module - this is the entry point for your entire app.

  ## What is a Supervision Tree?

  In Elixir, we organize our app as a tree of "supervisors" and "workers":

  ```
  Application (you are here)
       │
       ├── Store (GenServer) - manages likes data in ETS/DETS
       │
       ├── RateLimiter (GenServer) - tracks request counts per client
       │
       ├── GifValidator (GenServer) - caches valid GIF list from S3
       │
       └── Cowboy (HTTP Server) - handles incoming requests
  ```

  If any worker crashes, the supervisor can restart it automatically.
  This is the "let it crash" philosophy - instead of defensive coding,
  we let things fail and recover automatically.

  ## Why `use Application`?

  This macro gives us the `start/2` callback that the BEAM calls
  when your app boots. It's like the `main()` function in other languages.
  """

  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    # Log that we're starting up
    Logger.info("Starting GIF Likes Server...")

    # Define our child processes (workers)
    # These start in ORDER - Store first, then RateLimiter, etc.
    # This matters because Router depends on Store being ready!
    children = [
      # 1. Start the likes store (ETS + DETS persistence)
      GifLikesServer.Store,

      # 2. Start the rate limiter
      GifLikesServer.RateLimiter,

      # 3. Start the GIF validator (loads valid GIFs from S3)
      GifLikesServer.GifValidator,

      # 4. Start the HTTP server on port 4000
      # Plug.Cowboy wraps the Cowboy web server
      {Plug.Cowboy,
        scheme: :http,
        plug: GifLikesServer.Router,
        options: [port: port()]}
    ]

    # Supervisor options:
    # - strategy: :one_for_one means if one child crashes, only restart THAT child
    #   (alternatives: :one_for_all restarts ALL children, :rest_for_one restarts
    #   the crashed one and all children started AFTER it)
    # - name: gives our supervisor a name so we can find it later
    opts = [strategy: :one_for_one, name: GifLikesServer.Supervisor]

    Logger.info("Server running at http://localhost:#{port()}")

    # Start the supervisor with our children
    # This blocks until the supervisor is up and all children are started
    Supervisor.start_link(children, opts)
  end

  # Helper to get the port from environment or default to 4000
  defp port do
    # System.get_env returns a string, so we need to parse it
    case System.get_env("PORT") do
      nil -> 4000
      port_string -> String.to_integer(port_string)
    end
  end
end
