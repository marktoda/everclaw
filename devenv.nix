{ pkgs, ... }:

{
  packages = [
    pkgs.uv
    pkgs.curl
    pkgs.jq
  ];
}
