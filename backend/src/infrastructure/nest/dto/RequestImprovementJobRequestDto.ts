import { IsString, MinLength } from 'class-validator';

export class RequestImprovementJobRequestDto {
  @IsString()
  @MinLength(1)
  filePath!: string;
}
