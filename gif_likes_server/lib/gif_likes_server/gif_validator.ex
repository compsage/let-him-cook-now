defmodule GifLikesServer.GifValidator do
  @moduledoc """
  GIF Validator - ensures GIF names are valid by checking against an S3 bucket.

  ## How It Works

  1. On startup, fetch the list of GIF files from S3
  2. Cache the list in ETS for fast lookups
  3. Periodically refresh the cache (in case GIFs are added/removed)

  ## Why Cache in ETS?

  We don't want to call S3 for every request - that would be:
  - Slow (network latency)
  - Expensive (S3 charges per request)
  - Unreliable (what if S3 is down?)

  So we fetch once, cache locally, and refresh periodically.

  ## Configuration

  Set these environment variables:
  - AWS_ACCESS_KEY_ID - your AWS access key
  - AWS_SECRET_ACCESS_KEY - your AWS secret
  - GIF_BUCKET - S3 bucket name (defaults to "gif-likes-bucket")
  - GIF_PREFIX - prefix/folder in bucket (defaults to "gifs/")

  ## Fallback Mode

  If S3 is unavailable or not configured, we fall back to allowing all GIFs.
  This is useful for local development without AWS credentials.
  """

  use GenServer
  require Logger

  # =============================================================================
  # CONFIGURATION
  # =============================================================================

  @ets_table :valid_gifs                 # ETS table for caching
  @refresh_interval_ms 300_000           # Refresh every 5 minutes
  @default_bucket "gif-likes-bucket"     # Default S3 bucket
  @default_prefix "gifs/"                # Default prefix in bucket

  # =============================================================================
  # PUBLIC API
  # =============================================================================

  @doc """
  Start the GIF validator GenServer.
  """
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Check if a GIF name is valid.

  Returns:
  - true (always, for testing - TODO: enable S3 validation later)

  ## Example

  ```elixir
  if GifValidator.valid?("funny-cat.gif") do
    # Process the like
  else
    # Return 404 Not Found
  end
  ```
  """
  def valid?(_gif_name) do
    # Always return true for testing core logic
    # TODO: Re-enable S3 validation when ready
    true
  end

  @doc """
  Get list of all valid GIF names.
  """
  def list_valid_gifs do
    @ets_table
    |> :ets.tab2list()
    |> Enum.filter(fn {key, _} -> key != :_fallback_mode and key != :_last_refresh end)
    |> Enum.map(fn {name, _} -> name end)
    |> Enum.sort()
  end

  @doc """
  Force a refresh of the GIF list from S3.
  """
  def refresh do
    GenServer.call(__MODULE__, :refresh, 30_000)  # 30 second timeout
  end

  @doc """
  Get stats about the validator.
  """
  def stats do
    fallback = case :ets.lookup(@ets_table, :_fallback_mode) do
      [{:_fallback_mode, true}] -> true
      _ -> false
    end

    last_refresh = case :ets.lookup(@ets_table, :_last_refresh) do
      [{:_last_refresh, time}] -> time
      _ -> nil
    end

    # Count actual GIFs (not metadata keys)
    gif_count = :ets.info(@ets_table, :size) - (if fallback, do: 1, else: 0) - (if last_refresh, do: 1, else: 0)

    %{
      valid_gif_count: max(gif_count, 0),
      fallback_mode: fallback,
      last_refresh: last_refresh,
      bucket: get_bucket(),
      prefix: get_prefix()
    }
  end

  # =============================================================================
  # GENSERVER CALLBACKS
  # =============================================================================

  @impl true
  def init(_opts) do
    Logger.info("Initializing GIF validator...")

    # Create ETS table for caching valid GIFs
    :ets.new(@ets_table, [
      :set,
      :named_table,
      :public,
      {:read_concurrency, true}
    ])

    # Try to load GIFs from S3 (async, don't block startup)
    # We use send(self(), ...) to trigger handle_info after init completes
    send(self(), :initial_load)

    {:ok, %{refresh_count: 0}}
  end

  @impl true
  def handle_info(:initial_load, state) do
    do_refresh()
    schedule_refresh()
    {:noreply, state}
  end

  @impl true
  def handle_info(:refresh, state) do
    do_refresh()
    schedule_refresh()
    {:noreply, %{state | refresh_count: state.refresh_count + 1}}
  end

  @impl true
  def handle_call(:refresh, _from, state) do
    result = do_refresh()
    {:reply, result, %{state | refresh_count: state.refresh_count + 1}}
  end

  # =============================================================================
  # PRIVATE FUNCTIONS
  # =============================================================================

  @doc false
  defp do_refresh do
    Logger.info("Refreshing GIF list from S3...")

    bucket = get_bucket()
    prefix = get_prefix()

    case fetch_from_s3(bucket, prefix) do
      {:ok, gif_names} ->
        # Clear old entries (except metadata)
        clear_gif_entries()

        # Insert new entries
        Enum.each(gif_names, fn name ->
          :ets.insert(@ets_table, {name, true})
        end)

        # Record refresh time and clear fallback mode
        :ets.insert(@ets_table, {:_last_refresh, DateTime.utc_now()})
        :ets.delete(@ets_table, :_fallback_mode)

        Logger.info("Loaded #{length(gif_names)} valid GIFs from S3")
        {:ok, length(gif_names)}

      {:error, reason} ->
        Logger.warning("Failed to load GIFs from S3: #{inspect(reason)}")
        Logger.warning("Falling back to allow-all mode")

        # Enable fallback mode
        :ets.insert(@ets_table, {:_fallback_mode, true})
        {:error, reason}
    end
  end

  @doc false
  defp fetch_from_s3(bucket, prefix) do
    # Check if AWS credentials are configured
    if aws_configured?() do
      try do
        # List objects in the S3 bucket with the given prefix
        result =
          bucket
          |> ExAws.S3.list_objects(prefix: prefix)
          |> ExAws.request()

        case result do
          {:ok, %{body: %{contents: contents}}} ->
            # Extract GIF filenames from S3 response
            gif_names =
              contents
              |> Enum.map(fn %{key: key} -> key end)
              |> Enum.filter(&String.ends_with?(&1, ".gif"))
              |> Enum.map(fn key ->
                # Remove the prefix to get just the filename
                String.replace_prefix(key, prefix, "")
              end)
              |> Enum.filter(&(&1 != ""))  # Remove empty strings

            {:ok, gif_names}

          {:ok, %{body: body}} when body == %{} or body == [] ->
            # Empty bucket
            {:ok, []}

          {:error, error} ->
            {:error, error}
        end
      rescue
        error ->
          {:error, {:exception, error}}
      end
    else
      Logger.info("AWS not configured, using fallback mode")
      {:error, :aws_not_configured}
    end
  end

  @doc false
  defp aws_configured? do
    # Check if AWS credentials are available
    # ExAws will look for credentials in:
    # 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
    # 2. ~/.aws/credentials file
    # 3. Instance metadata (on EC2)
    System.get_env("AWS_ACCESS_KEY_ID") != nil or
      File.exists?(Path.expand("~/.aws/credentials"))
  end

  @doc false
  defp clear_gif_entries do
    # Delete all entries except metadata keys
    @ets_table
    |> :ets.tab2list()
    |> Enum.each(fn {key, _} ->
      if key not in [:_fallback_mode, :_last_refresh] do
        :ets.delete(@ets_table, key)
      end
    end)
  end

  @doc false
  defp get_bucket do
    System.get_env("GIF_BUCKET") || @default_bucket
  end

  @doc false
  defp get_prefix do
    System.get_env("GIF_PREFIX") || @default_prefix
  end

  @doc false
  defp schedule_refresh do
    Process.send_after(self(), :refresh, @refresh_interval_ms)
  end
end
