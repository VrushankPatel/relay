class Relay < Formula
  desc "Provider-agnostic LLM caching and deduplication proxy"
  homepage "https://github.com/VrushankPatel/relay"
  url "https://github.com/VrushankPatel/relay.git", branch: "master"
  version "2.2.0"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install"
    system "npm", "run", "build"
    
    # Copy compiled output and node modules to libexec
    libexec.install "dist", "package.json", "node_modules"
    
    # Create a wrapper script in bin pointing to the Node entrypoint
    (bin/"relay").write <<~EOS
      #!/bin/bash
      exec node "#{libexec}/dist/index.js" "$@"
    EOS
  end

  test do
    assert_match "Relay CLI", shell_output("#{bin}/relay --help")
  end
end
