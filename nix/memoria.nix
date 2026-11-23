# El paquete `memoria`: la CLI de cli-memoria (cli/memoria.mjs con sus módulos de cli/lib/) y un ejecutable que la
# corre con Node 22. Sin dependencias de npm ni compilación: los .mjs se copian tal cual. Va en Linux y en macOS.
#
# Disposición, que lisa usa tal cual (kit/paquetes.nix la envuelve con su kit/envoltorio.nix): no la cambies sin avisar allí.
#   $out/lib/memoria/memoria.mjs   el programa
#   $out/lib/memoria/lib/          sus módulos (nativa.mjs, paginas.mjs, pasarela.mjs)
#   $out/bin/memoria               node + el programa; git y rg al final del PATH (los del usuario van antes)
{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs_22,
  git,
  ripgrep,
}:

stdenvNoCC.mkDerivation {
  pname = "memoria";
  version = "2.3.0"; # la VERSION de cli/memoria.mjs

  src = lib.fileset.toSource {
    root = ../cli;
    fileset = lib.fileset.unions [
      ../cli/memoria.mjs
      ../cli/lib
    ];
  };

  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/memoria
    cp -r memoria.mjs lib $out/lib/memoria/
    makeWrapper ${lib.getExe nodejs_22} $out/bin/memoria \
      --add-flags $out/lib/memoria/memoria.mjs \
      --suffix PATH : ${
        lib.makeBinPath [
          git
          ripgrep
        ]
      }
    runHook postInstall
  '';

  meta = {
    description = "memoria: la CLI de cli-memoria (buscar, leer y escribir las notas)";
    license = lib.licenses.asl20;
    mainProgram = "memoria";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
