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
        listen = {
          address = "127.0.0.1";
          port = 8782;
        };
        tokensFile = "/etc/cli-memoria-tokens.toml";
      };
      # The service starts in the test script, once its token exists.
      systemd.services.cli-memoria.wantedBy = pkgs.lib.mkForce [ ];
    };

  testScript = ''
    machine.wait_for_unit("multi-user.target")

    # No git remote: the server creates its own notes repo in its data dir and is its only writer.
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

    seeded = call('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create","arguments":{"path":"temas/universidad.md","content":"---\\nname: Universidad\\ndescription: Carrera\\n---\\n# Universidad\\n\\nCinco asignaturas.\\n","reason":"Nota inicial"}}}')
    assert '\\"commit\\"' in seeded, seeded

    found = call('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{"query":"asignaturas"}}}')
    assert "temas/universidad.md" in found, found

    created = call('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create","arguments":{"path":"temas/coche.md","content":"---\\nname: Coche\\ndescription: Coche familiar\\n---\\n# Coche\\n","reason":"Nota de prueba"}}}')
    assert '\\"commit\\"' in created, created

    last = machine.succeed("git -c safe.directory='*' -C /var/lib/cli-memoria/repo log -1 --format='%an|%s'")
    assert last.strip() == "Tester|Nota de prueba", last

    # The git webhook is gone.
    machine.fail("curl -sf -X POST http://127.0.0.1:8782/hooks/git -d '{}'")

    machine.fail("curl -sf http://127.0.0.1:8782/mcp -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{}'")
  '';
}
