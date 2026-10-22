/** 规则错误：机器可读的 code 加面向玩家的中文说明。 */

export type RuleErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'CARDS_NOT_IN_HAND'
  | 'WRONG_CARD_COUNT'
  | 'INVALID_DECLARATION'
  | 'DECLARATION_TOO_WEAK'
  | 'NOT_DEALER'
  | 'INVALID_FRIEND_CALL'
  | 'MIXED_GROUPS'
  | 'MUST_FOLLOW_SUIT'
  | 'MUST_MATCH_STRUCTURE'
  | 'INVALID_GUOHE'
  | 'INVALID_ZAOFAN'
  | 'INVALID_ACTION';

export interface RuleError {
  readonly code: RuleErrorCode;
  readonly message: string;
}

export function ruleError(code: RuleErrorCode, message: string): RuleError {
  return { code, message };
}
