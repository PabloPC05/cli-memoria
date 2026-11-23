{
  description = "cli-memoria: self-hosted, git-backed memory for AI agents (CLI memoria and MCP server)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      # La CLI `memoria` (nix/memoria.nix) va también en macOS; el servidor, solo en Linux.
      systemsCli = systems ++ [
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      forAllCli = f: nixpkgs.lib.genAttrs systemsCli (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = nixpkgs.lib.recursiveUpdate
        (forAll (pkgs: {
          default = pkgs.callPackage ./nix/package.nix { };
        }))
        (forAllCli (pkgs: {
          memoria = pkgs.callPackage ./nix/memoria.nix { };
        }));

      nixosModules.default = import ./nix/module.nix self;

      checks = forAll (pkgs: {
        module = pkgs.testers.runNixOSTest (import ./nix/test.nix self);
      });
    };
}
