'use strict'
const C = require('../constants/constants');
const MediaSession = require('./media-session');

/**
 * @classdesc
 * Class for handling MCU sessions in mcs-core.
 */
class MCUSession extends MediaSession {
  constructor(room, options) {
    super(room, null, C.MEDIA_TYPE.MCU, options);
  }

  async process() {
    try {
      let videoAdapter = this._adapters.videoAdapter;

      this.medias = await videoAdapter.negotiate(this.roomId, this.roomId,
        this.id, null, this.type, this._options);

      this.mediaTypes.audio = 'sendrecv';
      this.mediaTypes.video = 'sendrecv';
      return this._id;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = MCUSession;
