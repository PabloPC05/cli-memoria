{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  git,
}:

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

  # git is called as a program; the wrapper puts the pinned one first. Nothing else is needed: the memory is Markdown
  # notes, and the documents it cites live in the archives of lisa (no attachments, no OCR, no git-lfs).
  postInstall = ''
    wrapProgram $out/bin/cli-memoria \
      --prefix PATH : ${lib.makeBinPath [ git ]}
    ln -s cli-memoria $out/bin/my-memory
  '';

  meta = {
    description = "Self-hosted, git-backed memory server for AI agents (MCP)";
    license = lib.licenses.asl20;
    mainProgram = "cli-memoria";
    platforms = lib.platforms.linux;
  };
}
