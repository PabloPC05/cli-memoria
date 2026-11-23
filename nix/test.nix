self:
{ pkgs, ... }:

{
  name = "cli-memoria-module";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];
      environment.systemPackages = [
        pkgs.git
        pkgs.curl
        pkgs.jq
      ];
      services.cli-memoria = {
        enable = true;
        remote.url = "/srv/notes.git";
        listen = {
          address = "127.0.0.1";
          port = 8782;
        };
        tokensFile = "/etc/cli-memoria-tokens.toml";
        fetchIntervalSeconds = 0;
      };
      # The service starts in the test script, once the remote exists. The remote here is a local
      # path, which ProtectSystem=strict makes read-only unless allowed (a real remote is HTTP).
      systemd.services.cli-memoria.wantedBy = pkgs.lib.mkForce [ ];
      systemd.services.cli-memoria.serviceConfig.ReadWritePaths = [ "/srv/notes.git" ];
    };

  testScript = ''
    machine.wait_for_unit("multi-user.target")

    # A bare repo with one note, owned by the service user (it pushes to it).
    machine.succeed(
      "git init -q --bare -b main /srv/notes.git",
      "git clone -q /srv/notes.git /tmp/seed",
      "mkdir -p /tmp/seed/temas",
      "printf -- '---\\nname: Universidad\\ndescription: Carrera\\n---\\n# Universidad\\n\\nCinco asignaturas.\\n' > /tmp/seed/temas/universidad.md",
      "git -C /tmp/seed -c user.name=t -c user.email=t@t add -A",
      "git -C /tmp/seed -c user.name=t -c user.email=t@t commit -qm seed",
      "git -C /tmp/seed push -q origin main",
      "chown -R cli-memoria:cli-memoria /srv/notes.git",
    )
    token = machine.succeed("cli-memoria token add tester --name Tester --scope write --file /etc/cli-memoria-tokens.toml").strip()
    machine.succeed("chgrp cli-memoria /etc/cli-memoria-tokens.toml && chmod 0640 /etc/cli-memoria-tokens.toml")
    machine.succeed("systemctl start cli-memoria")
    machine.wait_for_open_port(8782)

    # OCR tools are found at startup (tesseract with spa+eng, pdftoppm).
    machine.succeed("journalctl -u cli-memoria -o cat | grep ocr.tools | grep -F '\"pdf\":true,\"image\":true'")
    machine.succeed("journalctl -u cli-memoria -o cat | grep ocr.tools | grep -F '\"languages\":\"spa+eng\"'")

    def call(body):
        return machine.succeed(
            "curl -sf http://127.0.0.1:8782/mcp "
            f"-H 'Authorization: Bearer {token}' "
            "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "
            f"-d '{body}'"
        )

    init = call('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')
    assert "cli-memoria" in init, init

    found = call('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"asignaturas"}}}')
    assert "temas/universidad.md" in found, found

    created = call('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create","arguments":{"path":"temas/coche.md","content":"---\\nname: Coche\\ndescription: Coche familiar\\n---\\n# Coche\\n","reason":"Nota de prueba"}}}')
    assert '\\"commit\\"' in created, created
    assert "PUSH_PENDING" not in created, created

    last = machine.succeed("git --git-dir /srv/notes.git log -1 --format='%an|%s'")
    assert last.strip() == "Tester|Nota de prueba", last

    machine.fail("curl -sf http://127.0.0.1:8782/mcp -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{}'")
  '';
}
