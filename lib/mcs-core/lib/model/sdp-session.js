/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const C = require('../constants/constants');
const SdpWrapper = require('../utils/sdp-wrapper');
const rid = require('readable-id');
const MediaSession = require('./media-session');
const SDPMedia = require('./sdp-media');
const config = require('config');
const Logger = require('../utils/logger');
const AdapterFactory = require('../adapters/adapter-factory');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Balancer = require('../media/balancer');
const LOG_PREFIX = "[mcs-sdp-session]";

/**
 * Timeout before restarting DMTF command timer
 * @type {Number}
 */
const DEFAULT_DTMF_TIMEOUT = 3000;

/**
 * Default DIGITs length for DTMF codes. After pressing the first digit,
 * the session will wait DEFAULT_DTMF_TIMEOUT ms for the next digit(s).
 * @type {Number}
 */
const DEFAULT_DTMF_CODE_LENGTH = 2;

module.exports = class SDPSession extends MediaSession {
  constructor(
    remoteDescriptor = null,
    room,
    user,
    type = 'WebRtcEndpoint',
    options
  ) {
    super(room, user, type, options);
    // {SdpWrapper} SdpWrapper
    this._remoteDescriptor;
    this._localDescriptor;

    this.negotiationRole = '';
    this.shouldRenegotiate = false;
    this.shouldProcessRemoteDescriptorAsAnswerer = false;

    if (remoteDescriptor) {
      this.remoteDescriptor = remoteDescriptor;
    }

    this._dtmfQueue = [];
    this._dtmfTimeoutObject = null;

    Logger.info(LOG_PREFIX,  "New session created", JSON.stringify(this.getMediaInfo()));
  }

  set remoteDescriptor (remoteDescriptor) {
    if (remoteDescriptor) {
      if (this.localDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.ANSWERER;
      }

      if (this._remoteDescriptor) {
        this.shouldRenegotiate = true;
      } else if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        this.shouldProcessRemoteDescriptorAsAnswerer = true;
      }

      this._remoteDescriptor = new SdpWrapper(remoteDescriptor, this.mediaSpecs, this._mediaProfile);

      if (this.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.remoteDescriptor);
      }
    }
  }

  set shouldProcessRemoteDescriptorAsAnswerer (value) {
    if (value === true && !this.shouldProcessRemoteDescriptorAsAnswerer) {
      GLOBAL_EVENT_EMITTER.emit(`${C.EVENT.MEDIA_NEGOTIATED}:${this.id}`,
        this.getMediaInfo());
    }

    this._shouldProcessRemoteDescriptorAsAnswerer = value;
  }

  get shouldProcessRemoteDescriptorAsAnswerer () {
    return this._shouldProcessRemoteDescriptorAsAnswerer;
  }

  get remoteDescriptor () {
    return this._remoteDescriptor;
  }

  set localDescriptor (localDescriptor) {
    if (localDescriptor) {
      this._localDescriptor = new SdpWrapper(localDescriptor, this.mediaSpecs, this._mediaProfile);

      if (this.remoteDescriptor == null && !this.negotiationRole) {
        this.negotiationRole = C.NEGOTIATION_ROLE.OFFERER;
      }

      if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
        this.mediaSpecs = SdpWrapper.updateSpecWithChosenCodecs(this.localDescriptor);
      }
    }
  }

  get localDescriptor () {
    return this._localDescriptor;
  }

  get dtmfQueue () {
    return this._dtmfQueue;
  }

  set dtmfQueue (queue) {
    this._dtmfQueue = queue;
  }

  get dtmfTimeoutObject () {
    return this._dtmfTimeoutObject;
  }

  set dtmfTimeoutObject (timeoutObject) {
    this._dtmfTimeoutObject = timeoutObject;
  }

  /**
   * Callback for handling DTMF event sent by audio medias (rfc2833) in
   * this session
   * @param  {Number}  digit DTMF digit
   * @return {Promise} A Promise for this process
   */
  async _handleDtmfEvent(digit) {
    try {

      if (digit != null) {
        let dtmfTimeout = DEFAULT_DTMF_TIMEOUT;
        let dtmfCodeLength = DEFAULT_DTMF_CODE_LENGTH;

        if (this.dtmfTimeoutObject) {
          this.dtmfQueue.push(digit);

          if (this.dtmfQueue.length >= dtmfCodeLength) {
            this._processDtmfCommand(dtmfCodeLength);
            return;
          }

          clearTimeout(this.dtmfTimeoutObject);
          this.dtmfTimeoutObject =
            setTimeout (this._processDtmfCommand.bind(this), dtmfTimeout,
              dtmfCodeLength);
        } else {
          this.dtmfQueue = [];
          this.dtmfQueue.push(digit);

          this.dtmfTimeoutObject =
            setTimeout (this._processDtmfCommand.bind(this), dtmfTimeout,
              dtmfCodeLength);
        }
      }

    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async _processDtmfCommand (dtmfCodeLength) {
    try {

      if (!this.dtmfQueue || (this.dtmfQueue.length < dtmfCodeLength)) {
        this._restartDtmfCommand();
        return;
      }

      let command = this.dtmfQueue[0];
      let codes = this.dtmfQueue.slice(1);

      if (command && codes) {
        switch (command) {

        case '*':
        case 10: {
          let floorId = parseInt(codes.join(""), 10);

          if (floorId == "3") {
            await this.toggleSubtitle();
          } else if (floorId == "4") {
            await this.toggleMediaSubtitle();
          } else  {
            await this.setVideoFloor();
          }
          break;
        }

        case '#':
        case (11): {
          let layoutId = codes.join("");
          await this.setLayoutType(layoutId);
          break;
        }

        default:
          Logger.info(LOG_PREFIX, "Unknown DTMF command:", command);
          break;
        }
      }
      this._restartDtmfCommand();
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _restartDtmfCommand() {
    try {
      clearTimeout (this.dtmfTimeoutObject);
      this.dtmfQueue = [];
      this.dtmfTimeoutObject = null;
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async setLayoutType(layoutId) {
    try {
      if (this._adapters.videoAdapter) {
        let medias = this.videoMedias.filter(media =>
          media.type === C.MEDIA_TYPE.HUBPORT);

        await this._adapters.videoAdapter.setLayoutType(medias[0], layoutId);
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async setVideoFloor() {
    try {
      if (this._adapters.videoAdapter) {
        let medias = this.videoMedias.filter(media =>
          media.type === C.MEDIA_TYPE.HUBPORT);

        await this._adapters.videoAdapter.setVideoFloor(medias[0]);
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async toggleSubtitle() {
    try {
      if (this._adapters.videoAdapter) {
        let medias = this.videoMedias.filter(media =>
          media.type === C.MEDIA_TYPE.HUBPORT);

        if (!medias[0]) {
          return;
        }

        await this._adapters.videoAdapter.toggleSubtitle(medias[0].mixerId);
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async toggleMediaSubtitle() {
    try {
      if (this._adapters.videoAdapter) {
        let medias = this.videoMedias.filter(media =>
          media.type === C.MEDIA_TYPE.HUBPORT);

        if (!medias[0]) {
          return;
        }

        await this._adapters.videoAdapter.toggleMediaSubtitle(medias[0].mixerId,
          medias[0].id);
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async _defileAndProcess () {
    const {
      videoAdapter,
      audioAdapter,
      contentAdapter
    } = this._adapters;

    let videoMedias = [];
    let audioMedias = [];
    let contentMedias = [];

    // Check if we have a remote descriptor yet. If not, we're the offerer.
    // In this case, the descriptor is just null and should be handled by the adapter
    // as an indicator of offers needed to be generated
    const videoDescription = this.remoteDescriptor? this.remoteDescriptor.mainVideoSdp : null;
    const audioDescription = this.remoteDescriptor? this.remoteDescriptor.audioSdp : null;
    const contentDescription = this.remoteDescriptor? this.remoteDescriptor.contentVideoSdp : null;

    // Set the media options according to the role we're performing. If we're the offerer,
    // we have to specify what're going to generate to the adapter manually.
    const isAnswerer = this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER;
    const audioOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.AUDIO };
    const videoOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.MAIN };
    const contentOptions = isAnswerer ?
      this._options :
      { ...this._options, mediaProfile: C.MEDIA_PROFILE.CONTENT };

    if (this.remoteDescriptor == null || (this.remoteDescriptor && audioDescription)) {
      try {
        audioMedias = await audioAdapter.negotiate(this.roomId, this.userId, this.id,
          audioDescription, this.type, audioOptions);
        audioMedias.forEach(m => {
          m.localDescriptor = SdpWrapper.getAudioSDP(m.localDescriptor._plainSdp)
          m.on(C.EVENT.MEDIA_DTMF, this._handleDtmfEvent.bind(this))
        });
      } catch (e) {
        this._handleError(e);
      }
    }

    if (this.remoteDescriptor == null || (this.remoteDescriptor && videoDescription)) {
      try {
        videoMedias = await videoAdapter.negotiate(this.roomId, this.userId, this.id,
          videoDescription, this.type, videoOptions);
        videoMedias.forEach(m => {
          const partialLocalDescriptor = m.localDescriptor._plainSdp;
          const mainDescriptor = SdpWrapper.getVideoSDP(partialLocalDescriptor);
          m.localDescriptor = mainDescriptor;
        });
      } catch (e) {
        this._handleError(e);
      }
    }

    if (this.remoteDescriptor == null || (this.remoteDescriptor && contentDescription)) {
      try {
        contentMedias = await contentAdapter.negotiate(this.roomId, this.userId, this.id,
          contentDescription, this.type, contentOptions);
        contentMedias.forEach(m => {
          const partialLocalDescriptor = m.localDescriptor._plainSdp;
          const contentDescriptor = SdpWrapper.getContentSDP(partialLocalDescriptor);
          m.localDescriptor = contentDescriptor;
        });
      } catch (e) {
        this._handleError(e);
      }
    }

    this.medias = this.medias.concat(audioMedias, videoMedias, contentMedias);

    const localDescriptor = this.getAnswer();
    this.localDescriptor = localDescriptor;
    return localDescriptor;
  }

  renegotiateStreams () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;

        // There are checks here for shouldProcessRemoteDescriptorAsAnswerer because
        // we don't support full, unlimited renegotiation as of now due to media
        // server limitations. I understand this is kinda coupling the session
        // logic to a limitation of Kurento and this should be handled there.
        // I'll do it once I have time - prlanzarin 25/04/2018 FIXME
        if (this.remoteDescriptor.mainVideoSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            const videoMedia = this.medias.find(m => m.mediaTypes.video);
            Logger.info(LOG_PREFIX, `Processing answerer video streams for session ${this.id} at media ${videoMedia.id}: ${this.remoteDescriptor.mainVideoSdp}`);
            const descBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.mainVideoSdp);
            const mainWithInvalidAudio = this.remoteDescriptor.sessionDescriptionHeader + 'm=audio 0 RTP/AVP 96 97\n\ra=inactive\n\r' + descBody;
            await videoAdapter.processAnswer(videoMedia.adapterElementId, mainWithInvalidAudio);
            videoMedia.remoteDescriptor = this.remoteDescriptor.mainVideoSdp;
          } catch (e) {
            this._handleError(e);
          }
        }

        if (this.remoteDescriptor.audioSdp && this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            const audioMedia = this.medias.find(m => m.mediaTypes.audio);
            Logger.info(LOG_PREFIX, `Processing answerer audio streams for session ${this.id} at media ${audioMedia.id}: ${this.remoteDescriptor.audioSdp}`);
            const adescBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.audioSdp);
            const mainWithInvalidVideo = this.remoteDescriptor.sessionDescriptionHeader + adescBody;

            await audioAdapter.processAnswer(audioMedia.adapterElementId, mainWithInvalidVideo);
            audioMedia.remoteDescriptor = this.remoteDescriptor.audioSdp;
          }
          catch (e) {
            this._handleError(e);
          }
        }

        if (this.remoteDescriptor.contentVideoSdp) {
          if (this.shouldProcessRemoteDescriptorAsAnswerer) {
            const contentMedia = this.medias.find(m => m.mediaTypes.content);
            Logger.info(LOG_PREFIX, `Processing answerer content streams for session ${this.id} at media ${contentMedia.id}: ${this.remoteDescriptor.contentVideoSdp}`);
            const descBody = this.remoteDescriptor.removeSessionDescription(this.remoteDescriptor.contentVideoSdp);
            const contentWithInvalidAudio = this.remoteDescriptor.sessionDescriptionHeader + 'm=audio 0 RTP/AVP 96 97\n\ra=inactive\n\r' + descBody;
            await contentAdapter.processAnswer(contentMedia.adapterElementId, contentWithInvalidAudio);
            contentMedia.remoteDescriptor = this.remoteDescriptor.contentVideoSdp;
          } else if (!this.localDescriptor || !this.localDescriptor.contentVideoSdp) {
          Logger.info(LOG_PREFIX, "Renegotiating content streams for", this.id, this.remoteDescriptor.contentVideoSdp)
            try {
              const contentMedias = await contentAdapter.negotiate(this.roomId, this.userId, this.id,
                this.remoteDescriptor.contentVideoSdp, this.type, this._options);
              this.medias = this.medias.concat(contentMedias);
            } catch (e) {
              this._handleError(e);
            }
          }
        }

        this.localDescriptor = this.getAnswer();

        return resolve(this.localDescriptor._plainSdp);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  process () {
    return new Promise(async (resolve, reject) => {
      try {
        const {
          videoAdapter,
          audioAdapter,
          contentAdapter
        } = this._adapters;
        let localDescriptor;

        // If this is marked for renegotiation, do it
        if (this.shouldRenegotiate || this.shouldProcessRemoteDescriptorAsAnswerer) {
          try {
            localDescriptor = await this.renegotiateStreams();
            if (this.shouldProcessRemoteDescriptorAsAnswerer) {
              this.shouldProcessRemoteDescriptorAsAnswerer = false;
            }
            return resolve(localDescriptor);
          } catch (e) {
            return reject(this._handleError(e));
          }
        }

        if (AdapterFactory.isComposedAdapter(this._adapter)) {
          localDescriptor = await this._defileAndProcess(this.remoteDescriptor);
        } else {
          // The adapter is the same for all media types, so either one will suffice
          let remoteDescriptor = this.remoteDescriptor ? this.remoteDescriptor.plainSdp : null;
          this.medias = await videoAdapter.negotiate(this.roomId, this.userId, this.id, remoteDescriptor, this.type, this._options);
          localDescriptor = this.getAnswer();
          this.localDescriptor = localDescriptor;
        }

        localDescriptor = (this.localDescriptor && this.localDescriptor._plainSdp)? this.localDescriptor._plainSdp : null;

        Logger.trace('[mcs-sdp-session] The wizard responsible for this session', this.id, 'processed the following localDescriptors', localDescriptor);

        // Checks if the media server was able to find a compatible media line
        if (this.medias.length <= 0 && this.remoteDescriptor) {
          return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
        }

        if (this.remoteDescriptor && localDescriptor) {
          if (!this._hasAvailableCodec()) {
            return reject(this._handleError(C.ERROR.MEDIA_NO_AVAILABLE_CODEC));
          }

        }

        this.fillMediaTypes();

        Logger.trace("[mcs-sdp-session] Answer SDP for session", this.id, localDescriptor);
        this.createAndSetMediaNames();

        // We only emit the MEDIA_NEGOTIATED event when the negotiation has been
        // sucessfully enacted. In the case where we are the answerer, we fire it here.
        // If we are the offerer, we fire it when the answer is properly
        // processed and the shouldProcessRemoteDescriptorAsAnswerer flag is
        // deactivated (see shouldProcessRemoteDescriptorAsAnswerer setter)
        if (this.negotiationRole === C.NEGOTIATION_ROLE.ANSWERER) {
          GLOBAL_EVENT_EMITTER.emit(`${C.EVENT.MEDIA_NEGOTIATED}:${this.id}`,
            this.getMediaInfo());
        }

        return resolve(localDescriptor);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  fillMediaTypes () {
    this.mediaTypes.video = this.medias.some(m => m.mediaTypes.video);
    this.mediaTypes.content = this.medias.some(m => m.mediaTypes.content) || this._mediaProfile === C.MEDIA_PROFILE.CONTENT;
    this.mediaTypes.audio = this.medias.some(m => m.mediaTypes.audio);
  }

  addIceCandidate (candidate) {
    return new Promise(async (resolve, reject) => {
      try {
        this.medias.forEach(m => {
          if (m.type === C.MEDIA_TYPE.WEBRTC) {
            m.addIceCandidate(candidate);
          }
        });
        resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  getAnswer () {
    let header = '', body = '';

    // Some endpoints demand that the audio description be first in order to work
    // FIXME this should be reviewed. The m= lines  order should match the
    // offer order, otherwise the Unified Plan partisans will complain
    const headDescription = this.medias.filter(m => m.mediaTypes.audio);
    const remainingDescriptions = this.medias.filter(m => !m.mediaTypes.audio);

    if (remainingDescriptions && remainingDescriptions[0]) {
      header = remainingDescriptions[0].localDescriptor.sessionDescriptionHeader;
    } else  if (this.medias[0]) {
      header = this.medias[0].localDescriptor.sessionDescriptionHeader;
    } else {
      return;
    }

    if (headDescription && headDescription[0]) {
      body += headDescription[0].localDescriptor.removeSessionDescription(headDescription[0].localDescriptor._plainSdp);
    }

    remainingDescriptions.forEach(m => {
      const partialLocalDescriptor = m.localDescriptor;
      if (partialLocalDescriptor) {
        body += partialLocalDescriptor.removeSessionDescription(partialLocalDescriptor._plainSdp)
      }
    });

    return header + body;
  }

  _hasAvailableCodec () {
    return (this.remoteDescriptor.hasAvailableVideoCodec() === this.localDescriptor.hasAvailableVideoCodec()) &&
      (this.remoteDescriptor.hasAvailableAudioCodec() === this.localDescriptor.hasAvailableAudioCodec());
  }
}
