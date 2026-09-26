import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Clients } from '../open-meteo/client.js';
import type { SummaryService } from '../summary/service.js';
import type { WatchService } from '../watch/service.js';

/**
 * Everything a tool handler needs.
 *
 * Built once per process and shared by every server instance. That sharing is
 * essential for the stateful tools: in stateless MCP mode a new server object is
 * created per HTTP request, so any state held on the server would be lost
 * between calls. The collector, its samples and the saved summaries live here
 * instead.
 */
export interface ToolDeps {
  clients: Clients;
  logger: Logger;
  config: Config;
  watches: WatchService;
  summaries: SummaryService;
}
