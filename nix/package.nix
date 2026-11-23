{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  git,
  git-lfs,
  poppler-utils,
  tesseract,
}:

let
  # OCR for scanned PDFs and images; only the language data the default config uses.
  tesseractOcr = tesseract.override {
    enableLanguages = [
      "eng"
      "spa"
    ];
  };
in

buildNpmPackage {
  pname = "cli-memoria";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../bin
      ../docs/agent-setup.md
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-8gjIT2KrCfmSleOQkEi/mw4R/p+RBKS0RNT+kb5tMIM=";
  npmBuildScript = "build";

  nativeBuildInputs = [ makeWrapper ];

  # git, git-lfs, poppler (pdftotext, pdftoppm) and tesseract are called as programs; the wrapper
  # puts the pinned ones first. OCR stays optional at runtime: without them it is just unavailable.
  postInstall = ''
    wrapProgram $out/bin/cli-memoria \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          git-lfs
          poppler-utils
          tesseractOcr
        ]
      }
    ln -s cli-memoria $out/bin/my-memory
  '';

  meta = {
    description = "Self-hosted, git-backed memory server for AI agents (MCP)";
    license = lib.licenses.asl20;
    mainProgram = "cli-memoria";
    platforms = lib.platforms.linux;
  };
}
