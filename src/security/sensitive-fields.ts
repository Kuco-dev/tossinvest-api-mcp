/** redaction 대상 정의. logger / error normalizer / dry-run 요약이 공유한다. */

/** 값 자체를 절대 노출하면 안 되는 키 (부분 일치, 대소문자 무시). */
export const SECRET_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /client[_-]?secret/i,
  /^secret$/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /^token$/i,
  /authorization/i,
  /^cookie$/i,
  /set-cookie/i,
  /password/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /credential/i,
]);

/** 앞뒤 일부만 남기고 마스킹할 키 (식별자 성격). */
export const MASK_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /client[_-]?id/i,
  /account[_-]?seq/i,
  /^account$/i,
  /account[_-]?no/i,
  /account[_-]?number/i,
  /x-tossinvest-account/i,
]);

/** 자산/보유 정보처럼 로그에 남기면 안 되는 응답 키. */
export const PRIVATE_PAYLOAD_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^holdings?$/i,
  /^balance$/i,
  /^quantity$/i,
  /^orderAmount$/i,
  /^buyingPower$/i,
  /^marketValue$/i,
  /^profitLoss$/i,
]);

export const REDACTED = '[REDACTED]';
