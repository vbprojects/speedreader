import { standardPresentations } from "./standard";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WordStream } from "../epub/types";
import { presenters, sourceCapabilities, type PresentedStream, type PresenterPipeline } from "./registry";
import type { PresenterSelection } from "./types";
import type { ReaderEngineEvent } from "../engine-events/types";

export function usePresenters(stream: WordStream, format: string, selection: PresenterSelection) {
  const standard = useMemo(() => ({ ...stream, presentations: standardPresentations(stream) }), [stream]);
  const pipeline = useRef<PresenterPipeline | null>(null);
  const [result, setResult] = useState<{ source: WordStream; config: string; value: PresentedStream }>();
  const [error, setError] = useState("");
  const config = JSON.stringify(selection);
  useEffect(() => {
    setError("");
    try { pipeline.current = presenters.open(JSON.parse(config), sourceCapabilities(format)); }
    catch (error) { pipeline.current = null; setError(error instanceof Error ? error.message : String(error)); }
    return () => { pipeline.current?.dispose(); pipeline.current = null; };
  }, [config, format]);
  useEffect(() => {
    let active = true;
    const current = pipeline.current;
    if (current) void current.update(stream).then(value => {
      if (active) { setResult({ source: stream, config, value }); setError(""); }
    }).catch(error => {
      if (active && error?.name !== "AbortError") {
        current.dispose(); if (pipeline.current === current) pipeline.current = null;
        setResult(undefined); setError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => { active = false; };
  }, [stream, config, format]);
  return { stream: result?.source === stream && result.config === config ? result.value.stream : standard,
    layouts: result?.source === stream && result.config === config ? result.value.layouts : [],
    error, handleEvent: async (event: ReaderEngineEvent) => await pipeline.current?.handleEvent(event) ?? false };
}
