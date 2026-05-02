import { IsOptional, IsString, Matches } from 'class-validator';

export class RegisterRepositoryRequestDto {
  @IsString()
  @Matches(/github\.com[/:]([^/]+)\/([^/]+)/i, {
    message: 'url must be a github.com repository URL',
  })
  url!: string;

  /**
   * Optional path inside the repo where the package's `package.json` lives.
   * Empty / omitted = repo root (the common case). Use for monorepos:
   * 'backend', 'apps/web', 'packages/core', etc.
   *
   * Validated as a clean relative path: alphanumerics, dot, dash, underscore,
   * separated by single slashes. No leading/trailing slash, no '..',
   * no spaces. Empty string is also accepted.
   */
  @IsOptional()
  @IsString()
  @Matches(/^$|^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/, {
    message:
      "subpath must be a clean relative path (e.g. 'backend' or 'apps/web'); no leading slash, no '..'",
  })
  subpath?: string;
}
