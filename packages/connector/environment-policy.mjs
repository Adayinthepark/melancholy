export function safeCredentialName(name) {
  return (
    /_(KEY|TOKEN|SECRET|PASSWORD|ID|URL|JSON|CERTIFICATE)$/.test(name) &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(name) &&
    !/^(MELANCHOLY|LARK|LARKSUITE|CODEX|CLAUDE|NODE|NPM|LD|DYLD|PYTHON|BASH|SHELL|GIT|GITHUB|GH|CF|CLOUDFLARE)(_|$)/.test(
      name,
    ) &&
    ![
      "PATH",
      "HOME",
      "PWD",
      "OLDPWD",
      "USER",
      "LOGNAME",
      "ENV",
      "IFS",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SHELLOPTS",
      "BASHOPTS",
      "CDPATH",
      "ZDOTDIR",
      "COMSPEC",
      "PATHEXT",
      "SYSTEMROOT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ].includes(name)
  );
}
