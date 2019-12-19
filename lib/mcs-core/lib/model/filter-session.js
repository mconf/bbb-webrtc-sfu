'use strict'
const C = require('../constants/constants');
const MediaSession = require('./media-session');
const Logger = require('../utils/logger');
const LOG_PREFIX = '[mcs-filter-session]';

/**
 * @classdesc
 * Class for handling Filter sessions in mcs-core.
 */
class FilterSession extends MediaSession {
  constructor(roomId, userId, options) {
    super(roomId, userId, C.MEDIA_TYPE.FILTER, options);
  }

  async process(connectionType, filterType, args) {
    try {
      if (connectionType != C.CONNECTION_TYPE.VIDEO) {
        Logger.warn(LOG_PREFIX, 'Could not process the filter: connection',
          'type [', connectionType, '] not supported');
        return;
      }

      let videoAdapter = this._adapters.videoAdapter;

      switch (filterType) {
        case C.FILTER_TYPE.VIDEOSCALE:
          if (!args) {
            throw new Error('Invalid args, the object must contain width and',
              'height properties');
          }

          Logger.info(LOG_PREFIX, 'Processing VIDEOSCALE filter', args);
          this.medias = await videoAdapter.createScaleMediaFilter(this.roomId,
            args.width, args.height);

          this.mediaTypes.video = 'sendrecv';
        break;
        default:
        break;
      }
    } catch (error) {
      throw error;
    }
  }
}

module.exports = FilterSession;
