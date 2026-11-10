export interface ProvenanceLabel {
  chip: string;
  note: string | null;
}

const SCRIPTED_NOTE =
  "Pre-written draft from fixtures/llm-cache. This is not real Claude output. Set NVIDIA_API_KEY or ANTHROPIC_API_KEY for a real model draft.";

export function provenanceLabel(model: string, source: "live" | "replayed"): ProvenanceLabel {
  const separator = model.indexOf(":");
  const vendor = separator > 0 ? model.slice(0, separator) : "";
  const name = separator > 0 ? model.slice(separator + 1) : model;
  const real = vendor === "nvidia" || vendor === "anthropic";
  if (source === "replayed") {
    return real
      ? { chip: `Recorded real model output: ${name}`, note: null }
      : { chip: "Scripted demo fixture", note: SCRIPTED_NOTE };
  }
  return vendor === "nvidia"
    ? { chip: `Real model: ${name} via NVIDIA, recorded`, note: null }
    : { chip: `Live · ${name}`, note: null };
}
