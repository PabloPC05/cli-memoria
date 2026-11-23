self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    optional
    optionalAttrs
    ;
  cfg = config.services.cli-memoria;
  toml = pkgs.formats.toml { };

  # Tesseract with just the language data the OCR config asks for. Only referenced (so only built) with OCR on.
  ocrTesseract = pkgs.tesseract.override { enableLanguages = lib.unique cfg.ocr.languages; };

  # Secrets reach the service through systemd credentials; the config only names them.
  credentials =
    optional (cfg.remote != null && cfg.remote.tokenFile != null) "remote-token:${cfg.remote.tokenFile}"
    ++ optional (cfg.webhookSecretFile != null) "webhook-secret:${cfg.webhookSecretFile}";

  settings =
    {
      data_dir = "/var/lib/cli-memoria";
      inherit (cfg) branch;
      author_domain = cfg.authorDomain;
      fetch_interval_seconds = cfg.fetchIntervalSeconds;
      log_level = cfg.logLevel;
      pdftotext = "${pkgs.poppler-utils}/bin/pdftotext";
      ocr =
        {
          enabled = cfg.ocr.enable;
        }
        // optionalAttrs cfg.ocr.enable {
          languages = lib.concatStringsSep "+" cfg.ocr.languages;
          max_pages = cfg.ocr.maxPages;
          page_timeout_seconds = cfg.ocr.pageTimeoutSeconds;
          inherit (cfg.ocr) dpi;
          tesseract = "${ocrTesseract}/bin/tesseract";
          pdftoppm = "${pkgs.poppler-utils}/bin/pdftoppm";
        };
      listen = {
        inherit (cfg.listen) address port;
      };
    }
    // optionalAttrs (cfg.tokensFile != null) { tokens_file = cfg.tokensFile; }
    // optionalAttrs (cfg.webhookSecretFile != null) { webhook_secret_file = "credential:webhook-secret"; }
    // optionalAttrs (cfg.remote != null) {
      remote =
        {
          inherit (cfg.remote) url username;
        }
        // optionalAttrs (cfg.remote.tokenFile != null) { token_file = "credential:remote-token"; };
    };

  configFile = toml.generate "cli-memoria.toml" settings;
in
{
  options.services.cli-memoria = {
    enable = mkEnableOption "cli-memoria, a git-backed memory server for AI agents (MCP)";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The cli-memoria package.";
    };

    branch = mkOption {
      type = types.str;
      default = "main";
    };

    authorDomain = mkOption {
      type = types.str;
      default = "cli-memoria.invalid";
      description = "Domain of commit author emails (<client-id>@<domain>).";
    };

    remote = mkOption {
      default = null;
      description = "Git remote of the notes repo. Without it the repo stays local.";
      type = types.nullOr (
        types.submodule {
          options = {
            url = mkOption { type = types.str; };
            username = mkOption {
              type = types.str;
              default = "cli-memoria";
            };
            tokenFile = mkOption {
              type = types.nullOr types.str;
              default = null;
              description = "File with the remote password or access token (HTTP basic auth).";
            };
          };
        }
      );
    };

    listen = {
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "Bind address for the HTTP listener (MCP, uploads and git webhook).";
      };
      port = mkOption {
        type = types.port;
        default = 8782;
        description = "Bind port for the HTTP listener.";
      };
    };

    tokensFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        TOML file with static token hashes, managed with `cli-memoria token add|list|revoke --file <it>`.
        Read directly (not as a credential) so `systemctl reload cli-memoria` picks up changes; it must be
        readable by the cli-memoria group.
      '';
    };

    webhookSecretFile = mkOption {
      type = types.nullOr types.str;
      default = null;
    };

    fetchIntervalSeconds = mkOption {
      type = types.int;
      default = 300;
      description = "Safety-net fetch from the remote, in case a webhook is missed. 0 disables it.";
    };

    ocr = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "OCR scanned PDFs (pdftoppm + tesseract) and images (tesseract) when they are attached.";
      };
      languages = mkOption {
        type = types.listOf types.str;
        default = [
          "spa"
          "eng"
        ];
        example = [
          "spa"
          "eng"
          "fra"
        ];
        description = "Tesseract languages, in order of preference; their language data is installed for the service.";
      };
      maxPages = mkOption {
        type = types.ints.positive;
        default = 50;
        description = "Pages of a scanned PDF that are OCR'd; the rest is left out with a warning.";
      };
      pageTimeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 120;
        description = "Time limit for rendering and recognising one page or image.";
      };
      dpi = mkOption {
        type = types.ints.positive;
        default = 300;
        description = "Resolution at which scanned PDF pages are rendered for OCR.";
      };
    };

    logLevel = mkOption {
      type = types.enum [
        "debug"
        "info"
        "warn"
        "error"
      ];
      default = "info";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.ocr.enable || cfg.ocr.languages != [ ];
        message = "services.cli-memoria: ocr.languages must name at least one language";
      }
    ];

    users.users.cli-memoria = {
      isSystemUser = true;
      group = "cli-memoria";
      home = "/var/lib/cli-memoria";
    };
    users.groups.cli-memoria = { };

    environment.systemPackages = [ cfg.package ];
    environment.etc."cli-memoria/config.toml".source = configFile;

    systemd.services.cli-memoria = {
      description = "cli-memoria MCP server";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      restartTriggers = [ configFile ];
      environment = {
        HOME = "/var/lib/cli-memoria";
        NODE_ENV = "production";
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/cli-memoria serve --config ${configFile}";
        ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
        User = "cli-memoria";
        Group = "cli-memoria";
        StateDirectory = "cli-memoria";
        StateDirectoryMode = "0750";
        WorkingDirectory = "/var/lib/cli-memoria";
        LoadCredential = credentials;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0027";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        CapabilityBoundingSet = "";
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        # V8's JIT needs writable+executable memory.
        MemoryDenyWriteExecute = false;
      };
    };
  };
}
