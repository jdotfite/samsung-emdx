let runtimeState = {
  host: "127.0.0.1",
  port: 0
};

export function setRuntimeState(nextState) {
  runtimeState = {
    ...runtimeState,
    ...nextState
  };
}

export function getRuntimeState() {
  return runtimeState;
}
