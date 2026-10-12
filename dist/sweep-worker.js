/* Runs the parameter sweep off the main thread and streams finished grid cells. */
'use strict';
importScripts('engine.js');
self.onmessage = (event) => {
  const { data, config, axes } = event.data, total = axes[0].values.length * axes[1].values.length;
  let batch = [];
  try {
    self.postMessage({ type: 'screening' });
    Lab.sweep(data, config, axes, (point, done) => {
      batch.push(point);
      if (batch.length >= 6 || done === total) { self.postMessage({ type: 'points', points: batch, done, total }); batch = []; }
    });
    self.postMessage({ type: 'done' });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
