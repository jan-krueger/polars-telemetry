import { useMemo } from "react";
import type { PlanNode, Profile } from "../model/profile";
import { momentAt, nodeAt, type Moment } from "../lib/replay";

export default function useMoment(profile: Profile | null, replayAt: number | null): { moment: Moment | null; physical: PlanNode[] } {
  const moment = useMemo(
    () => (profile?.replay && replayAt !== null ? momentAt(profile.replay, replayAt) : null),
    [profile, replayAt],
  );
  const physical = useMemo(
    () => (profile && moment ? profile.plan.physical.map((n) => nodeAt(n, moment)) : profile?.plan.physical ?? []),
    [profile, moment],
  );
  return { moment, physical };
}
