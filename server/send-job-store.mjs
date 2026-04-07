import crypto from "node:crypto";

const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function createSendJob({ imageName, screens }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    imageName,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    stage: "queued",
    error: "",
    targets: screens.map((screen) => ({
      screenId: screen.id,
      name: screen.name,
      host: screen.device.host,
      status: "queued",
      stage: "queued",
      error: "",
      delivery: null,
      milestones: {
        wakeSent: false,
        connected: false,
        contentSet: false,
        contentJsonFetched: false,
        imageFetched: false
      },
      events: []
    }))
  };

  jobs.set(id, job);
  return structuredClone(job);
}

export function getSendJob(jobId) {
  const job = jobs.get(jobId);
  return job ? structuredClone(job) : null;
}

function mutateJob(jobId, updater) {
  const job = jobs.get(jobId);
  if (!job) {
    return null;
  }
  updater(job);
  job.updatedAt = nowIso();
  jobs.set(jobId, job);
  return structuredClone(job);
}

export function markSendJobRunning(jobId) {
  return mutateJob(jobId, (job) => {
    job.status = "running";
    job.stage = "preparing";
  });
}

export function recordSendJobEvent(jobId, screenId, event) {
  return mutateJob(jobId, (job) => {
    job.status = "running";
    const target = job.targets.find((entry) => entry.screenId === screenId);
    if (!target) {
      return;
    }

    const normalized = {
      ...event,
      at: event.at || nowIso()
    };
    target.events.push(normalized);
    target.status = "running";

    switch (normalized.type) {
      case "waking_start":
      case "wake_sent":
      case "wake_done":
      case "wake_wait_start":
      case "wake_probe_retry":
      case "wake_probe_success":
      case "wake_ready":
      case "wake_wait_timeout":
        target.stage = "waking";
        target.milestones.wakeSent = true;
        job.stage = "waking";
        break;
      case "connected":
        target.stage = "connected";
        target.milestones.connected = true;
        job.stage = "sending";
        break;
      case "content_set":
        target.stage = "commanded";
        target.milestones.contentSet = true;
        job.stage = "sending";
        break;
      case "content_json_served":
        target.stage = "frame_fetching";
        target.milestones.contentJsonFetched = true;
        job.stage = "verifying";
        break;
      case "image_served":
        target.stage = "image_verified";
        target.milestones.imageFetched = true;
        job.stage = "verifying";
        break;
      case "attempt_retry":
        target.stage = "retrying";
        job.stage = "sending";
        break;
      case "failed":
        target.stage = "failed";
        target.status = "failed";
        target.error = normalized.message || "Send failed.";
        job.status = "failed";
        job.stage = "failed";
        job.error = target.error;
        break;
      default:
        break;
    }
  });
}

export function completeSendJobTarget(jobId, screenId, result) {
  return mutateJob(jobId, (job) => {
    const target = job.targets.find((entry) => entry.screenId === screenId);
    if (!target) {
      return;
    }
    target.status = "completed";
    target.stage = target.milestones.imageFetched ? "image_verified" : "completed";
    target.delivery = result.delivery || null;
  });
}

export function failSendJob(jobId, error, screenId = "") {
  return mutateJob(jobId, (job) => {
    job.status = "failed";
    job.stage = "failed";
    job.error = error;

    if (screenId) {
      const target = job.targets.find((entry) => entry.screenId === screenId);
      if (target) {
        target.status = "failed";
        target.stage = "failed";
        target.error = error;
      }
    }
  });
}

export function finishSendJob(jobId) {
  return mutateJob(jobId, (job) => {
    if (job.status === "failed") {
      return;
    }
    job.status = "completed";
    job.stage = "completed";
  });
}
