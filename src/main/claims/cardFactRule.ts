/**
 * CLAIMS-90 R3 (god 066d84): the one place the answer-one-value rule is spelled. It is shipped in
 * what real agents read: PROTOCOL.md's memory section and the head of the `memory wake-up` brief.
 * The answerer instruction quotes this text verbatim and adds nothing, so the test path coaches
 * agents no more than the app does. Change it here only.
 */
export const CARD_FACT_RULE = 'For a card fact, run `memory get <CARD-ID>` and give the single current value; list others only when asked for history.';
