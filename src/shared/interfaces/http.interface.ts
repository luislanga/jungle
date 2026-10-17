export interface HttpRequestContext {
  correlationId: string;
}

export interface HttpStatusResponse {
  status(code: number): unknown;
}
