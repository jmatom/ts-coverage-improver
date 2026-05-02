import { Controller, Get, Inject } from '@nestjs/common';
import { AppConfig } from './AppConfig';
import { TOKENS } from './tokens';

/**
 * Exposes the safe-to-show subset of AppConfig to the dashboard.
 *
 * The frontend calls this on mount so its threshold-input default mirrors
 * `DEFAULT_COVERAGE_THRESHOLD` rather than a hardcoded literal. Anything
 * sensitive (PATs, API keys, socket paths) is *never* surfaced here.
 */
@Controller('config')
export class ConfigController {
  constructor(@Inject(TOKENS.Config) private readonly config: AppConfig) {}

  @Get()
  get() {
    return {
      defaultCoverageThreshold: this.config.defaultCoverageThreshold,
    };
  }
}
