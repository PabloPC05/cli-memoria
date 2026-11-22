# La CLI `memoria` (kit/memoria/memoria.mjs, con la paginación de kit/badulaque/paginas.mjs) con su envoltorio (kit/envoltorio.nix). Lo usan lisa y el Mac, vía kit/paquetes.nix.
{ pkgs }:
import ../envoltorio.nix { inherit pkgs; } {
  nombre = "memoria";
  programa = ./memoria.mjs;
  compartidos.badulaque = [ ../badulaque/paginas.mjs ];
}
