export function classifyHealth(variance, actualPct, thresholds = {}) {
  const onTrack = Number(thresholds.on_track_variance ?? -5);
  const slight = Number(thresholds.slight_delay_variance ?? -15);
  const atRisk = Number(thresholds.at_risk_variance ?? -25);
  if (Number(actualPct) >= 100) return 'COMPLETED';
  if (variance > 5) return 'AHEAD';
  if (variance >= onTrack) return 'ON_TRACK';
  if (variance >= slight) return 'SLIGHT_DELAY';
  if (variance >= atRisk) return 'AT_RISK';
  return 'CRITICAL';
}

export function allocateTopicsToSlots(topics, availableSlots, fallbackStartDate) {
  const scheduledItems = [];
  let slotIndex = 0;
  let totalEstimatedPeriods = 0;

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const requiredPeriods = Math.max(1, topic.estimated_periods || 1);
    totalEstimatedPeriods += requiredPeriods;

    let topicStartDate = null;
    let topicEndDate = null;

    if (slotIndex < availableSlots.length) {
      topicStartDate = availableSlots[slotIndex].date;
      slotIndex += requiredPeriods;
      const lastSlot = availableSlots[Math.min(slotIndex - 1, availableSlots.length - 1)];
      topicEndDate = lastSlot ? lastSlot.date : topicStartDate;
    } else {
      const lastKnown = availableSlots[availableSlots.length - 1]?.date || fallbackStartDate;
      topicStartDate = lastKnown;
      topicEndDate = lastKnown;
    }

    scheduledItems.push({
      curriculum_topic_id: topic.id,
      topic_title: topic.title,
      chapter_id: topic.chapter_id,
      planned_start_date: topicStartDate,
      planned_end_date: topicEndDate,
      planned_periods: requiredPeriods,
      sequence: i + 1,
      priority: topic.is_optional ? 'LOW' : 'NORMAL',
      status: 'NOT_STARTED',
      is_optional: topic.is_optional
    });
  }

  return { scheduledItems, totalEstimatedPeriods, consumedSlots: slotIndex };
}
