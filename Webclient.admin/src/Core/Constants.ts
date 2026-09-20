export const Constants = Object.freeze({
  ServiceResultType: Object.freeze({
    Success: 10,
    Error: 20,
  }),
  Session: Object.freeze({
    SessionObjectTitle: "_cviaıq34gmx",
  }),
  ExportTypes: Object.freeze({
    CSV: "csv",
    XLS: "xlsx",
  }),
  MessageTypes: Object.freeze({
    Success: 10,
    Error: 20,
    Warning: 30,
    Info: 40,
  }),
  LayerTypes: Object.freeze([
    Object.freeze(["MapImageLayer", 0] as const),
    Object.freeze(["FeatureLayer", 2] as const),
    Object.freeze(["WMS", 3] as const),
  ]),
  AccountTypes: Object.freeze({
    LDAP: 1,
    EXTERNAL: 2,
  }),
  ActionTypes: Object.freeze({
    API: 1,
    CLIENT: 2,
  }),
  LoadingStatus: Object.freeze({
    NONE: 0,
    SUBMITTED: 1,
    FAILED: 2,
    LOADING: 3,
  }),
  SessionStatus: Object.freeze({
    UNDECIDED: 0,
    NOT_EXISTS: 1,
    EXISTS: 2,
  }),
});

export type MessageType = (typeof Constants.MessageTypes)[keyof typeof Constants.MessageTypes];
export type LoadingStatus = (typeof Constants.LoadingStatus)[keyof typeof Constants.LoadingStatus];
export type SessionStatus = (typeof Constants.SessionStatus)[keyof typeof Constants.SessionStatus];
