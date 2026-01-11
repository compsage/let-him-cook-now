defmodule GifLikesServerTest do
  use ExUnit.Case
  doctest GifLikesServer

  test "greets the world" do
    IO.puts("hello do you have some gifs to like?")
    assert GifLikesServer.hello() == :world
  end
end
