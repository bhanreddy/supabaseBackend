import test from 'node:test';
import assert from 'node:assert/strict';
import { CALIBRATION, getLegCalibrationStatus } from './transportCalibrationService.js';

test('route calibration requires four successful clean trips', () => {
  assert.equal(CALIBRATION.CLEAN_TRIPS_TO_CALIBRATE, 4);
});

test('driver calibration status exposes the server threshold', async () => {
  const fakeDb = async () => [];
  const status = await getLegCalibrationStatus(17, 'route-1', 'morning', fakeDb);

  assert.equal(status.clean_trip_count, 0);
  assert.equal(status.required_clean_trip_count, 4);
  assert.equal(status.is_calibrated, false);
});
