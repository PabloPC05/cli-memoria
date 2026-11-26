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
      description = "Directory holding the notes repo clone and its SQLite index.";
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

    listen = {
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
        description = "Bind address for the HTTP listener (MCP).";
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
      # No secrets travel as systemd credentials any more: the git remote and its webhook are gone (the notes repo is
      # local and the server is its only writer). The tokens file is read directly (see tokensFile).
      credentials = [ ];

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
          log_level = cfg.logLevel;
          listen = effectiveListen;
        }
        // optionalAttrs (cfg.tokensFile != null) { tokens_file = cfg.tokensFile; }
        ;

      configFile = toml.generate "${unitName}.toml" settings;
    in
    mkIf cfg.enable {
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
