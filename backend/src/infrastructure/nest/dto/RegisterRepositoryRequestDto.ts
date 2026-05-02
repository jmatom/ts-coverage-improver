import { IsString, Matches } from 'class-validator';

export class RegisterRepositoryRequestDto {
  @IsString()
  @Matches(/github\.com[/:]([^/]+)\/([^/]+)/i, {
    message: 'url must be a github.com repository URL',
  })
  url!: string;
}
