self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    mkDefault
    mkEnableOption
    mkIf
    mkMerge
    mkOption
    optional
    optionalAttrs
    types
    ;
  toml = pkgs.formats.toml { };

  listenSubmodule = types.submodule {
    options = {
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
      };
      port = mkOption { type = types.port; };
    };
  };

  mkOptions = defaultName: {
    enable = mkEnableOption "${defaultName}, a git-backed memory server for AI agents (MCP)";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The cli-memoria package.";
    };

    user = mkOption {
      type = types.str;
      default = defaultName;
      description = "System user the service runs as.";
    };

    group = mkOption {
      type = types.str;
      default = defaultName;
      description = "System group the service runs as.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/${defaultName}";
      description = "Directory holding the notes repo clone, SQLite index, activity log and uploads.";
    };

    branch = mkOption {
      type = types.str;
      default = "main";
    };

    authorDomain = mkOption {
      type = types.str;
      default = "${defaultName}.invalid";
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
              default = defaultName;
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
      private = mkOption {
        type = types.nullOr listenSubmodule;
        default = null;
        description = "Legacy alias for listen.{address,port}; when set, overrides listen.address and listen.port.";
      };
    };

    tokensFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        TOML file with static token hashes, managed with `cli-memoria token add|list|revoke --file <it>`.
        Read directly (not as a credential) so `systemctl reload ${defaultName}` picks up changes; it must be
        readable by the service group.
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

  mkService =
    unitName: cfg:
    let
      # Tesseract with just the language data the OCR config asks for. Only referenced (so only built) with OCR on.
      ocrTesseract = pkgs.tesseract.override { enableLanguages = lib.unique cfg.ocr.languages; };

      # Secrets reach the service through systemd credentials; the config only names them.
      credentials =
        optional (cfg.remote != null && cfg.remote.tokenFile != null) "remote-token:${cfg.remote.tokenFile}"
        ++ optional (cfg.webhookSecretFile != null) "webhook-secret:${cfg.webhookSecretFile}";

      effectiveListen =
        if cfg.listen.private != null then
          cfg.listen.private
        else
          {
            inherit (cfg.listen) address port;
          };

      # If dataDir sits directly under /var/lib/<name>, let systemd manage it via StateDirectory;
      # otherwise grant explicit ReadWritePaths so ProtectSystem=strict does not block writes.
      stateDirRel = lib.removePrefix "/var/lib/" cfg.dataDir;
      useStateDirectory =
        lib.hasPrefix "/var/lib/" cfg.dataDir && stateDirRel != "" && !lib.hasInfix "/" stateDirRel;

      settings =
        {
          data_dir = cfg.dataDir;
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
          listen = effectiveListen;
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

      configFile = toml.generate "${unitName}.toml" settings;
    in
    mkIf cfg.enable {
      assertions = [
        {
          assertion = !cfg.ocr.enable || cfg.ocr.languages != [ ];
          message = "services.${unitName}: ocr.languages must name at least one language";
        }
      ];

      users.users.${cfg.user} = {
        isSystemUser = mkDefault true;
        group = mkDefault cfg.group;
        home = mkDefault cfg.dataDir;
      };
      users.groups.${cfg.group} = { };

      environment.systemPackages = [ cfg.package ];
      environment.etc."${unitName}/config.toml".source = configFile;

      systemd.services.${unitName} = {
        description = "${unitName} MCP server";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [ "network-online.target" ];
        restartTriggers = [ configFile ];
        environment = {
          HOME = cfg.dataDir;
          NODE_ENV = "production";
        };
        serviceConfig =
          {
            ExecStart = "${cfg.package}/bin/cli-memoria serve --config ${configFile}";
            ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
            User = cfg.user;
            Group = cfg.group;
            WorkingDirectory = cfg.dataDir;
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
          }
          // optionalAttrs useStateDirectory {
            StateDirectory = stateDirRel;
            StateDirectoryMode = "0750";
          }
          // optionalAttrs (!useStateDirectory) {
            ReadWritePaths = [ cfg.dataDir ];
          };
      };
    };
in
{
  options.services = {
    cli-memoria = mkOptions "cli-memoria";
    # Legacy service name kept for existing NixOS deployments (preserves /var/lib/my-memory and systemd unit name).
    my-memory = mkOptions "my-memory";
  };

  config = mkMerge [
    {
      assertions = [
        {
          assertion = !(config.services.cli-memoria.enable && config.services.my-memory.enable);
          message = "Enable only one of services.cli-memoria or services.my-memory, not both.";
        }
      ];
    }
    (mkService "cli-memoria" config.services.cli-memoria)
    (mkService "my-memory" config.services.my-memory)
  ];
}
