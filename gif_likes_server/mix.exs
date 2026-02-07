defmodule GifLikesServer.MixProject do
  use Mix.Project

  # =============================================================================
  # PROJECT CONFIGURATION
  # =============================================================================
  # This file defines your Elixir project - think of it like package.json in Node.
  # It specifies dependencies, build settings, and how the app starts.

  def project do
    [
      app: :gif_likes_server,
      version: "0.1.0",
      elixir: "~> 1.14",
      start_permanent: Mix.env() == :prod,  # Crash if supervisor dies in production
      deps: deps()
    ]
  end

  # =============================================================================
  # APPLICATION CONFIGURATION
  # =============================================================================
  # This tells the BEAM VM how to start your application.
  # - extra_applications: built-in Erlang/Elixir apps we need
  # - mod: the module that starts our supervision tree (like the main() function)

  def application do
    [
      extra_applications: [:logger],  # Enable logging
      mod: {GifLikesServer.Application, []}  # Start our app via Application module
    ]
  end

  # =============================================================================
  # DEPENDENCIES
  # =============================================================================
  # These are pulled from hex.pm (Elixir's package registry, like npm).
  # Run `mix deps.get` after changing this to download them.

  defp deps do
    [
      # HTTP server - Plug is the interface, Cowboy is the actual server
      # Think of Plug like Express middleware, Cowboy like the Node HTTP server
      {:plug_cowboy, "~> 2.6"},

      # JSON encoding/decoding (like JSON.stringify/parse in JS)
      {:jason, "~> 1.4"},

      # AWS S3 client for fetching the valid GIF list
      {:ex_aws, "~> 2.4"},
      {:ex_aws_s3, "~> 2.4"},

      # HTTP client needed by ex_aws
      {:hackney, "~> 1.18"},

      # XML parsing needed by ex_aws for S3 responses
      {:sweet_xml, "~> 0.7"}
    ]
  end
end
