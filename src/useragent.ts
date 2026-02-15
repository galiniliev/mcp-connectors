export class UserAgentComposer {
  private _userAgent: string;
  private _mcpClientInfoAppended = false;

  constructor(packageVersion: string) {
    this._userAgent = `ARMConnections.MCP/${packageVersion} (local)`;
  }

  get userAgent(): string {
    return this._userAgent;
  }

  appendMcpClientInfo(info: { name: string; version: string } | undefined): void {
    if (!this._mcpClientInfoAppended && info?.name && info?.version) {
      this._userAgent += ` ${info.name}/${info.version}`;
      this._mcpClientInfoAppended = true;
    }
  }
}
