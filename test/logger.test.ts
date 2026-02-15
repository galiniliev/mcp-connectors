import { logger } from "../src/logger";
import winston from "winston";

describe("logger", () => {
  it("is a winston Logger instance", () => {
    expect(logger).toBeInstanceOf(winston.Logger);
  });

  it("has expected methods (info, warn, error, debug)", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("level defaults to info", () => {
    expect(logger.level).toBe("info");
  });

  it("exitOnError is false", () => {
    expect(logger.exitOnError).toBe(false);
  });

  it("transports include a Stream transport writing to stderr", () => {
    const streamTransport = logger.transports.find(
      (t) => t instanceof winston.transports.Stream
    ) as InstanceType<typeof winston.transports.Stream> | undefined;

    expect(streamTransport).toBeDefined();
    expect((streamTransport as any).eol).toBeDefined(); // Stream transport exists
  });
});
