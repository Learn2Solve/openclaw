const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

export type WhoopRecovery = {
  score: {
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
    user_calibrating: boolean;
  };
  sleep_id: string;
  cycle_id: string;
  created_at: string;
  updated_at: string;
};

export type WhoopSleep = {
  id: string;
  start: string;
  end: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: { baseline_milli: number; need_from_sleep_debt_milli: number };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
  nap: boolean;
};

export type WhoopWorkout = {
  id: string;
  start: string;
  end: string;
  sport_id: number;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    zone_duration: {
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    };
  };
};

export type WhoopCycle = {
  id: string;
  start: string;
  end?: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  };
};

export type WhoopProfile = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
};

export type WhoopBody = {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
};

type PaginatedResponse<T> = {
  records: T[];
  next_token?: string;
};

async function whoopGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${WHOOP_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whoop API error (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as T;
}

export async function getProfile(accessToken: string): Promise<WhoopProfile> {
  return whoopGet<WhoopProfile>("/v1/user/profile/basic", accessToken);
}

export async function getBody(accessToken: string): Promise<WhoopBody> {
  return whoopGet<WhoopBody>("/v1/user/measurement/body", accessToken);
}

export async function getRecoveries(accessToken: string, limit = 1): Promise<WhoopRecovery[]> {
  const data = await whoopGet<PaginatedResponse<WhoopRecovery>>(
    `/v2/recovery?limit=${limit}`,
    accessToken,
  );
  return data.records;
}

export async function getSleeps(accessToken: string, limit = 1): Promise<WhoopSleep[]> {
  const data = await whoopGet<PaginatedResponse<WhoopSleep>>(
    `/v2/activity/sleep?limit=${limit}`,
    accessToken,
  );
  return data.records;
}

export async function getWorkouts(accessToken: string, limit = 5): Promise<WhoopWorkout[]> {
  const data = await whoopGet<PaginatedResponse<WhoopWorkout>>(
    `/v2/activity/workout?limit=${limit}`,
    accessToken,
  );
  return data.records;
}

export async function getCycles(accessToken: string, limit = 1): Promise<WhoopCycle[]> {
  const data = await whoopGet<PaginatedResponse<WhoopCycle>>(
    `/v1/cycle?limit=${limit}`,
    accessToken,
  );
  return data.records;
}

function millisToHours(ms: number): string {
  return (ms / 3_600_000).toFixed(1);
}

export function formatRecovery(r: WhoopRecovery): string {
  const s = r.score;
  const lines = [
    `Recovery: ${s.recovery_score}%`,
    `Resting HR: ${s.resting_heart_rate} bpm`,
    `HRV: ${s.hrv_rmssd_milli.toFixed(1)} ms`,
  ];
  if (s.spo2_percentage != null) lines.push(`SpO2: ${s.spo2_percentage}%`);
  if (s.skin_temp_celsius != null) lines.push(`Skin temp: ${s.skin_temp_celsius.toFixed(1)}C`);
  if (s.user_calibrating) lines.push("(calibrating)");
  lines.push(`Updated: ${r.updated_at}`);
  return lines.join("\n");
}

export function formatSleep(s: WhoopSleep): string {
  const st = s.score.stage_summary;
  const lines = [
    `Sleep ${s.nap ? "(nap)" : ""}: ${s.start} - ${s.end}`,
    `Total in bed: ${millisToHours(st.total_in_bed_time_milli)}h`,
    `Awake: ${millisToHours(st.total_awake_time_milli)}h`,
    `Light: ${millisToHours(st.total_light_sleep_time_milli)}h`,
    `Deep (SWS): ${millisToHours(st.total_slow_wave_sleep_time_milli)}h`,
    `REM: ${millisToHours(st.total_rem_sleep_time_milli)}h`,
    `Cycles: ${st.sleep_cycle_count}, Disturbances: ${st.disturbance_count}`,
  ];
  if (s.score.sleep_performance_percentage != null) {
    lines.push(`Performance: ${s.score.sleep_performance_percentage}%`);
  }
  if (s.score.sleep_efficiency_percentage != null) {
    lines.push(`Efficiency: ${s.score.sleep_efficiency_percentage}%`);
  }
  if (s.score.respiratory_rate != null) {
    lines.push(`Respiratory rate: ${s.score.respiratory_rate.toFixed(1)} rpm`);
  }
  return lines.join("\n");
}

export function formatWorkout(w: WhoopWorkout): string {
  const s = w.score;
  return [
    `Workout (sport ${w.sport_id}): ${w.start} - ${w.end}`,
    `Strain: ${s.strain.toFixed(1)}`,
    `Avg HR: ${s.average_heart_rate} bpm, Max HR: ${s.max_heart_rate} bpm`,
    `Calories: ${(s.kilojoule / 4.184).toFixed(0)} kcal`,
  ].join("\n");
}

export function formatCycle(c: WhoopCycle): string {
  const s = c.score;
  return [
    `Cycle: ${c.start}${c.end ? ` - ${c.end}` : " (ongoing)"}`,
    `Day strain: ${s.strain.toFixed(1)}`,
    `Avg HR: ${s.average_heart_rate} bpm, Max HR: ${s.max_heart_rate} bpm`,
    `Calories: ${(s.kilojoule / 4.184).toFixed(0)} kcal`,
  ].join("\n");
}
