import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Clients } from '../open-meteo/client.js';

export interface ToolDeps {
  clients: Clients;
  logger: Logger;
  config: Config;
}
