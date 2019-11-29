'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const mediaServerClient = require('kurento-client');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/logger');
const Util = require('../../utils/util');
const isError = Util.isError;
const ERRORS = require('./errors.js');
const KMS_CLIENT = require('kurento-client');
const SdpWrapper = require('../../utils/sdp-wrapper');
const GLOBAL_EVENT_EMITTER = require('../../utils/emitter');
const SDPMedia = require('../../model/sdp-media');
const RecordingMedia = require('../../model/recording-media');
const Media = require('../../model/media');
//TODO/FIXME make this OUTPUT_BIT_RATE configurable
const OUTPUT_BIT_RATE = 1024;
const KURENTO_REMB_PARAMS = config.get('kurentoRembParams');
const ALLOWED_CANDIDATE_IPS = config.has('kurentoAllowedCandidateIps')
  ? config.get('kurentoAllowedCandidateIps')
  : [];

const LOG_PREFIX = "[mcs-kurento-adapter]";

let instance = null;

module.exports = class Kurento extends EventEmitter {
  constructor(balancer) {
    if (!instance){
      super();
      this.balancer = balancer;
      this._globalEmitter = GLOBAL_EVENT_EMITTER;
      this._mediaPipelines = {};
      this._mediaElements = {};
      this._pipelinePromises = [];
      this._mediaServer;
      this._status;
      this._reconnectionRoutine = null;
      this._transposingQueue = [];
      this.balancer.on(C.EVENT.MEDIA_SERVER_OFFLINE, this._destroyElementsFromHost.bind(this));
      this._globalEmitter.on(C.EVENT.ROOM_EMPTY, this._releaseAllRoomPipelines.bind(this));
      instance = this;

    }

    return instance;
  }

  _createMediaPipeline (hostId) {
    return new Promise((resolve, reject) => {
      const host = this.balancer.retrieveHost(hostId);
      const { client } = host;
      client.create('MediaPipeline', (e, p) => {
        if (e) {
          return reject(e);
        }

        p.host = host;
        p.transposers = {};
        p.activeElements = 0;

        return resolve(p);
      });
    });
  }

  async _getMediaPipeline (hostId, roomId) {
    try {
      const host = this.balancer.retrieveHost(hostId);
      const { client } = host;
      if (this._mediaPipelines[roomId] && this._mediaPipelines[roomId][host.id]) {
        Logger.info(LOG_PREFIX, 'Pipeline for', roomId, 'at host', host.id, ' already exists.');
        return this._mediaPipelines[roomId][host.id];
      } else {
        let pPromise;

        const pPromiseObj = this._pipelinePromises.find(pp => pp.id === roomId + hostId);

        if (pPromiseObj) {
          ({ pPromise } = pPromiseObj);
        }

        if (pPromise) {
          return pPromise;
        };

        pPromise = this._createMediaPipeline(hostId);

        this._pipelinePromises.push({ id: roomId + hostId, pPromise});

        const pipeline = await pPromise;

        if (this._mediaPipelines[roomId] == null) {
          this._mediaPipelines[roomId] = {};
        }

        this._mediaPipelines[roomId][host.id] = pipeline;

        this._pipelinePromises = this._pipelinePromises.filter(pp => pp.id !== roomId + hostId);

        Logger.info(LOG_PREFIX, "Created pipeline at room", roomId, "with host", hostId, host.id, pipeline.id);

        return pipeline;
      }
    }
    catch (err) {
      throw (this._handleError(err));
    }
  }

  _releaseAllRoomPipelines (room) {
    try {
      if (this._mediaPipelines[room]) {
        Object.keys(this._mediaPipelines[room]).forEach(async pk => {
          await this._releasePipeline(room, pk);
        });
      }
    } catch (e) {
      this._handleError(e);
    }
  }

  _releasePipeline (room, hostId) {
    return new Promise((resolve, reject) => {
      try {
        Logger.debug(LOG_PREFIX, "Releasing room", room, "pipeline at host", hostId);
        const pipeline = this._mediaPipelines[room][hostId];
        if (pipeline && typeof pipeline.release === 'function') {
          pipeline.release((error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            delete this._mediaPipelines[room][hostId];
            return resolve()
          });
        } else {
          return resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  _createElement (pipeline, type, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        // Filter only the appropriate options for this adapter call
        const { stopOnEndOfStream, uri, recordingProfile } = options;
        pipeline.create(
          type,
          { stopOnEndOfStream, uri, mediaProfile: recordingProfile },
          (error, mediaElement) => {
            if (error) {
              return reject(this._handleError(error));
            }
            Logger.info(LOG_PREFIX, "Created [" + type + "] media element: " + mediaElement.id);
            mediaElement.host = pipeline.host;
            mediaElement.pipeline = pipeline;
            mediaElement.transposers = {};
            this._mediaElements[mediaElement.id] = mediaElement;
            return resolve(mediaElement);
          });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    let media;
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateWebRTCEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.RECORDING:
          return this._negotiateRecordingEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        case C.MEDIA_TYPE.URI:
          // TODO no-op
          break;
        case C.MEDIA_TYPE.MCU:
          return this._negotiateMCU(roomId, mediaSessionId, type, options);
        default:
          throw(this._handleError(ERRORS[40107].error));
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  _appendContentTypeIfNeeded (descriptor, mediaType) {
    // Check if we need to add :main or :slides
    // Since Kurento still does not treat a=content:x lines well, we
    // reappend it here manually to work around the issue
    switch (mediaType) {
      case C.MEDIA_PROFILE.MAIN:
        return descriptor + "a=content:main\r\n";
        break;
      case C.MEDIA_PROFILE.CONTENT:
        return descriptor + "a=content:slides\r\n";
        break;
      default:
        return descriptor;
        break;
    }
  }

  _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    Logger.debug(LOG_PREFIX, "Negotiating SDP endpoint for", userId, "at", roomId);
    try {
      // We strip the SDP into media units of the same type because Kurento can't handle
      // bundling other than audio + video
      const partialDescriptors = SdpWrapper.getPartialDescriptions(descriptor);
      let medias = []
      const negotiationProcedures = partialDescriptors.map((d, i) => {
        return new Promise(async (resolve, reject) => {
          try {
            let mediaElement, host, answer;

            // Some props are initialized as null because this is an early instantiation
            // done to please the balancer accounting
            const media = new SDPMedia(roomId, userId, mediaSessionId, d, null, type, this, null, null, options);
            const mediaType = this._parseMediaType(media);

            ({ mediaElement, host } = await this.createMediaElement(roomId, type, { ...options, mediaType }));

            if (d) {
              answer = await this.processOffer(mediaElement, d);
            } else {
              // If we're acting as offeree, we try to generate the least offensive SDP possible
              // for pure RTP endpoints as to minimize compatibility issues.
              // Hence the bizarre filters
              const filterOptions = [
                { reg: /AVPF/ig, val: 'AVP' },
                { reg: /a=mid:video0\r*\n*/ig, val: '' },
                { reg: /a=mid:audio0\r*\n*/ig, val: '' },
                { reg: /a=rtcp-fb:.*\r*\n*/ig, val: '' },
                { reg: /a=extmap:3 http:\/\/www.webrtc.org\/experiments\/rtp-hdrext\/abs-send-time\r*\n*/ig, val: '' },
                { reg: /a=setup:actpass\r*\n*/ig, val: '' }
              ]

              answer = await this.generateOffer(mediaElement, filterOptions);
            }

            answer = this._appendContentTypeIfNeeded(answer, mediaType);

            // Just do a late-set of the properties that were nullified in the early
            // media instantiation
            media.adapterElementId = mediaElement;
            media.host = host;
            media.localDescriptor = answer;
            media.remoteDescriptor = d;
            // Enable the event tracking
            media.trackMedia();
            medias[i] = media;

            resolve();
          } catch (err) {
            reject(this._handleError(err));
          }
        });
      });

      return Promise.all(negotiationProcedures).then(() => {
        return medias;
      });
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateWebRTCEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      const medias = await this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
      medias.forEach(m => {
        if (m.type === C.MEDIA_TYPE.WEBRTC) {
          this.gatherCandidates(m.adapterElementId);
        }
      });
      return medias;
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateRecordingEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    try {
      let mediaElement, host;

      // Some props are initialized as null because this is an early instantiation
      // done to please the balancer accounting
      const media = new RecordingMedia(roomId, userId, mediaSessionId, descriptor, null, type, this, null, null, options);
      const mediaType = this._parseMediaType(media);
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, {...options, mediaType }));
      const answer = await this.startRecording(mediaElement);
      // Just do a late-set of the properties that were nullified in the early
      // media instantiation
      media.adapterElementId = mediaElement;
      media.host = host;
      media.localDescriptor = answer;
      media.updateHostLoad();
      // Enable the event tracking
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  /**
   * Handle MCU (Composite mixer) element negotiation.
   * Here we basically create a 'Composite' for MCU sessions.
   * Hubports aren't created here, but when connecting Media sessions
   * in/to MCU sessions.
   * @param  {String}  roomId         The id of the room.
   * @param  {String}  mediaSessionId The id of the media session to be
   *                                  negotiated.
   * @param  {String}  type           The type of this media.
   * @param  {Object}  options        Additional params for the negotiation
   *                                  process.
   * @return {Promise}                A Promise for this process.
   */
  async _negotiateMCU (roomId, mediaSessionId, type, options) {
    try {
      let compositeMediaElement;
      let compositeMediaElementId;
      let createdMediaElement;

      Logger.info(LOG_PREFIX, 'Negotiating new MCU Media session with id:',
        mediaSessionId);

      createdMediaElement =
        await this.createMediaElement(roomId, 'Composite', options);

      Logger.info(LOG_PREFIX, 'Created video mixer element for the session:',
        mediaSessionId);

      compositeMediaElementId = createdMediaElement.mediaElement;
      compositeMediaElement = this._mediaElements[compositeMediaElementId];
      compositeMediaElement._numberOfHubPorts = 0;
      compositeMediaElement._hubPorts = {};

      let media = new Media(roomId, roomId, mediaSessionId, type,
        this, compositeMediaElement.id, compositeMediaElement.host, options);

      media.mediaTypes.video = 'sendrecv';
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
    }

  _parseMediaType (options) {
    // FIXME I'm not a fan of the mediaProfile vs mediaType boogaloo
    const { mediaProfile, mediaTypes }  = options;

    if (mediaProfile) {
      return mediaProfile;
    }

    if (mediaTypes) {
      const { video, audio, content } = mediaTypes;
      if (video) {
        return C.MEDIA_PROFILE.MAIN;
      } else if (audio) {
        return C.MEDIA_PROFILE.AUDIO;
      } else if (content) {
        return C.MEDIA_PROFILE.CONTENT;
      }
    }

    return C.MEDIA_PROFILE.ALL;
  }

  createMediaElement (roomId, type, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const { mediaType, keyframeInterval } = options;
        const host = await this.balancer.getHost(mediaType);
        await this._getMediaPipeline(host.id, roomId);
        const pipeline = this._mediaPipelines[roomId][host.id];
        const mediaElement = await this._createElement(pipeline, type, options);
        if (typeof mediaElement.setKeyframeInterval === 'function' && keyframeInterval) {
          Logger.debug(LOG_PREFIX, "Creating element with keyframe interval set to", keyframeInterval);
          mediaElement.setKeyframeInterval(keyframeInterval);
        }

        // TODO make the rembParams and In/Out BW values fetch from the conference
        // media specs
        if (type === C.MEDIA_TYPE.RTP || type === C.MEDIA_TYPE.WEBRTC) {
          this.setOutputBandwidth(mediaElement, 300, 1500);
          this.setInputBandwidth(mediaElement, 300, 1500);

          const rembParams = options.kurentoRembParams || KURENTO_REMB_PARAMS;
          if (rembParams) {
            const parsedRembParams = KMS_CLIENT.getComplexType('RembParams')(rembParams);
            mediaElement.setRembParams(parsedRembParams);
          }
        }

        this._mediaPipelines[roomId][host.id].activeElements++;

        return resolve({ mediaElement: mediaElement.id , host });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  /**
   * Set the current media as the video floor of the mixer it is bind to
   * @param  {Object}  media Media reference
   * @return {Promise}       A Promise for this process
   */
  async setVideoFloor (media) {
    try {
      if (!media) {
        Logger.debug(LOG_PREFIX, 'Could not set video floor, invalid media');
        return;
      }

      if (!media.mixerId) {
        Logger.debug(LOG_PREFIX, 'Could not set video floor, media is not ' +
          'bound to a video mixer');
        return;
      }

      let mixerElement = this._mediaElements[media.mixerId];

      if (!mixerElement) {
        Logger.debug(LOG_PREFIX, 'Could not set video floor, invalid ' +
          'mixerElement: ' + mixerId);
      }

      let mediaElement = this._mediaElements[media.adapterElementId];

      if (!mediaElement) {
        Logger.debug(LOG_PREFIX, 'Could not set video floor, invalid hubport ' +
          'media: ' + media.adapterElementId);
      }

      Logger.info(LOG_PREFIX, "Setting video floor to", media.adapterElementId);
      await mixerElement.setVideoFloor(mediaElement);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Set the current media as the video floor of the mixer it is bind to
   * @param  {Object}  media Media reference
   * @param  {Number}  layoutId The layout id
   * @return {Promise}       A Promise for this process
   */
  async setLayoutType (media, layoutId) {
    try {
      if (!media) {
        Logger.debug(LOG_PREFIX, 'Could not set layout type, invalid media');
        return;
      }

      if (!layoutId) {
        Logger.debug(LOG_PREFIX, 'Could not set layout type, invalid ' +
          'layout id');
        return;
      }

      if (!media.mixerId) {
        Logger.debug(LOG_PREFIX, 'Could not set layout type, media is not ' +
          'bound to a video mixer');
        return;
      }

      let mixerElement = this._mediaElements[media.mixerId];

      if (!mixerElement) {
        Logger.debug(LOG_PREFIX, 'Could not set layout type, invalid ' +
          'mixerElement: ' + mixerId);
      }

      let mediaElement = this._mediaElements[media.adapterElementId];

      if (!mediaElement) {
        Logger.debug(LOG_PREFIX, 'Could not set layout type, invalid hubport ' +
          'media: ' + media.adapterElementId);
      }

      Logger.info(LOG_PREFIX, "Setting layout type to", media.adapterElementId);
      await mixerElement.setLayoutType(layoutId);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Create a hubport in the mixer identified by the given id.
   * @param  {String}  mixerId  The ID of the Mixer where the hubport is going
   *                            to be created at.
   * @return {Promise}         A Promise for the given Process.
   */
  async createHubPort (mixerId, enableSubtitle, subtitle) {
    try {
      let mixer = this._mediaElements[mixerId];
      let hubPort = await this._createHubPort(mixer);
      await this.setOutputBitrate(hubPort, (OUTPUT_BIT_RATE) * 1024 );
      hubPort.host = mixer.host;
      hubPort.pipeline = mixer.pipeline;

      mixer._numberOfHubPorts++;

      let hubPortMedia = await this._createHubPortMediaWithFilters(mixer,
        hubPort, enableSubtitle, subtitle);

      Logger.info(LOG_PREFIX, 'Created HubPort Media:', hubPortMedia.id,
        '. Current number of HubPorts:', mixer._numberOfHubPorts);

      this._mediaElements[hubPort.id] = hubPort;
      mixer._hubPorts[hubPortMedia.id] = hubPortMedia;

      let flagEnableSubtitle = enableSubtitle;
      if (!flagEnableSubtitle) {
        flagEnableSubtitle = true;
        await this._disableSubtitle(hubPortMedia);

      } else {
        flagEnableSubtitle = false;
        await this._enableSubtitle(hubPortMedia);
      }

      return hubPortMedia;
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async _createHubPortMediaWithFilters(mixer, hubPort, enableSubtitle,
    subtitle) {
    let hubPortMedia = new Media(mixer.roomId, null, null,
      C.MEDIA_TYPE.HUBPORT, this, hubPort.id, hubPort.host);
    hubPortMedia.mixerId = mixer.id;
    hubPortMedia.mediaTypes.video = 'sendrecv';

    hubPortMedia.subtitle = subtitle ? subtitle.slice(0,31) : "";
    hubPortMedia.enableSubtitle = enableSubtitle;

    let mediaFilter = await this._createMediaFilter(mixer, hubPort,
      hubPortMedia);
    this._mediaElements[mediaFilter.id] = mediaFilter;

    let mediaFilterCaps = await this._createMediaFilterCaps(mixer, hubPort,
      hubPortMedia);
    this._mediaElements[mediaFilterCaps.id] = mediaFilterCaps;

    return hubPortMedia;
  }

  async _createMediaFilter(mixer, hubPort, hubPortMedia){
    let command = this._generateTextOverlayCommand(hubPortMedia.subtitle);
    let mediaFilter =
      await this._createGstreamerFilter(hubPort.pipeline, command);
    hubPort.mediaFilter = mediaFilter;

    mediaFilter.host = mixer.host;
    mediaFilter.pipeline = mixer.pipeline;

    hubPortMedia.mediaFilter = new Media(mixer.roomId, null, null,
      C.MEDIA_TYPE.HUBPORT, this, mediaFilter.id, hubPort.host);
    hubPortMedia.mediaFilter.mediaTypes.video = 'sendrecv';

    return mediaFilter;
  }

  async _createMediaFilterCaps(mixer, hubPort, hubPortMedia){
    let commandCaps =
      'capsfilter caps="video/x-raw, width=1280, height=720"';
    let mediaFilterCaps =
      await this._createGstreamerFilter(hubPort.pipeline, commandCaps);

    hubPort.mediaFilterCaps = mediaFilterCaps;
    mediaFilterCaps.host = mixer.host;
    mediaFilterCaps.pipeline = mixer.pipeline;

    hubPortMedia.mediaFilterCaps = new Media(mixer.roomId, null, null,
      C.MEDIA_TYPE.HUBPORT, this, mediaFilterCaps.id, hubPort.host);
    hubPortMedia.mediaFilterCaps.mediaTypes.video = 'sendrecv';

    return mediaFilterCaps;
  }

  /**
   * Toggle subtitle of Composiion
   * @param {String}  id  The id of the Composition
   */
  async toggleSubtitle (id) {
    try {
      let mixer = this._mediaElements[id];

      mixer.enableSubtitle = !mixer.enableSubtitle;

      await Promise.all(Object.keys(mixer._hubPorts).map(
        async (hubPortMediaId) => {
          let hubPortMedia = mixer._hubPorts[hubPortMediaId];

          if (mixer.enableSubtitle) {
            await this._enableSubtitle(hubPortMedia);
          } else {
            await this._disableSubtitle(hubPortMedia);
          }
          hubPortMedia.enableSubtitle = mixer.enableSubtitle;
        }
      ));
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Toggle subtitle of the given mcu id and mediaId
   * @param  {String}  id  The id of the Composition
   * @param  {String}  hubPortMediaId  The id of the hubPortMedia in Composition
   * @return {Promise}  A Promise for the given process
   */
   async toggleMediaSubtitle (id, hubPortMediaId) {
    try {
      let mixer = this._mediaElements[id];

      let hubPortMedia = mixer._hubPorts[hubPortMediaId];

      hubPortMedia.enableSubtitle = !hubPortMedia.enableSubtitle;

      if (hubPortMedia.enableSubtitle) {
        await this._enableSubtitle(hubPortMedia);
      } else {
        await this._disableSubtitle(hubPortMedia);
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Enable subtitle of the given media
   * @param  {hubPortMedia}  hubPortMedia The media to have it's subtitle enabled
   * @return {Promise}       A Promise for the given process
   */
  async _enableSubtitle(hubPortMedia) {
  try {
    if (!hubPortMedia || !hubPortMedia.mediaFilter) {
    return;
     }
      let mediaFilterElement =
        this._mediaElements[hubPortMedia.mediaFilter.adapterElementId];
      await mediaFilterElement.setElementProperty("text",
        hubPortMedia.subtitle);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Disable subtitle of the given media
   * @param  {hubPortMedia}  hubPortMedia The media to have it's subtitle disabled
   * @return {Promise}       A Promise for the given process
   */
  async _disableSubtitle(hubPortMedia) {
    try {
      if (!hubPortMedia || !hubPortMedia.mediaFilter) {
        return;
      }
      let mediaFilterElement =
        this._mediaElements[hubPortMedia.mediaFilter.adapterElementId];
      await mediaFilterElement.setElementProperty("text", "");
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
  * Helper for creating a filter element in the given pipeline
  * @param  {Pipeline}  pipeline The Media Pipeline
  * @param  {String}  command  The command of the element to be created
  * @return {external:Promise.<MediaElementObject>}
  * @private
  */
  async _createGstreamerFilter(pipeline, _command) {
    try {
      return pipeline.create('GStreamerFilter', {command: _command});
      throw new Error('Could not create new filter - invalid command');
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _generateTextOverlayCommand(subtitle) {
    return 'textoverlay text="' +
      this._upperCaseFirstLetter(subtitle).slice(0,31) +
        '" font-desc="Carrois Gothic SC, style=Bold 36px" ' +
          'shaded-background=true shading-value="65" ' +
            'draw-shadow=false deltay="20"';
  }

  /**
  * Helper for UpperCasing the first letter of the subtitle
  * @param  {String} subtitle reference
  */
  _upperCaseFirstLetter(subtitle) {
    let upperCaseSubtitle = [];
    subtitle.split(' ').forEach((name) =>
      { upperCaseSubtitle.push(name.charAt(0).toUpperCase() + name.slice(1))});
    //  { upperCaseSubtitle.push(name.toUpperCase());

    return upperCaseSubtitle.join(' ');
  }
  /**
   * Create a HubPort element in the given mixer.
   * @param  {Object}  mixer The mixer element
   * @return {Promise}       A Promise for the given Process
   */
  async _createHubPort(mixer) {
    try {
      if (mixer) {
        return mixer.createHubPort();
      }

      throw new Error('Could not create new hubport - invalid composite mixer',
        mixer.id);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Destroy a HubPort element by it's element id.
   * @param  {Object}  id    The id of the hubPort element
   * @return {Promise}       A Promise for the given Process
   */
  async destroyHubPort(id) {
    try {
      let hubPort = this._mediaElements[id];
      return this._destroyHubPort(hubPort, hubPort.mediaFilter,
        hubPort.mediaFilterCaps);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Destroy a HubPort element.
   * @param  {Object}  hubPort The hubPort element
   * @param  {Object}  mediaFilter The mediaFilter element
   * @param  {Object}  mediaFilterCaps The mediaFilterCaps element
   * @return {Promise}       A Promise for the given Process
   */
  async _destroyHubPort(hubPort, mediaFilter, mediaFilterCaps) {
    try {
      if (hubPort) {
        delete this._mediaElements[hubPort.id];
        delete this._mediaElements[mediaFilter.id];
        delete this._mediaElements[mediaFilterCaps.id];
        hubPort.release();
        mediaFilter.release();
        mediaFilterCaps.release();
        return true;
      }

      throw new Error('Could not detroy new hubport - invalid hubport',
        hubPort.id);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Destroy a Remainig Media Filters related to the given Composite Element.
   * @param  {Object}  id    The id of the mixer element
   * @return {Promise}       A Promise for the given Process
   */
  async destroyRemainingMediaFilters(id) {
    try {
      let mixer = this._mediaElements[id];
      return this._destroyRemainingMediaFilters(mixer);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Destroy a Remainig Media Filters related to the given Composite Element.
   * @param  {Object}  mixer  The mixer element
   * @return {Promise}       A Promise for the given Process
   */
  async _destroyRemainingMediaFilters(mixer) {
    try {
      if (mixer) {
        let hubports = mixer._hubPorts || {};
        Object.keys(hubports).forEach(hubPortMediaId => {
          let hubPortMedia = hubports[hubPortMediaId];
          let mediaFilter = hubPortMedia.mediaFilter;
          let mediaFilterCaps = hubPortMedia.mediaFilterCaps;

          let mediaFilterElement =
            this._mediaElements[mediaFilter.adapterElementId];
          let mediaFilterCapsElement =
            this._mediaElements[mediaFilterCaps.adapterElementId];

          if (mediaFilterElement &&
            (typeof mediaFilterElement.release == 'function')) {
              mediaFilterElement.release();
            }

          if (mediaFilterCapsElement &&
            (typeof mediaFilterCapsElement.release == 'function')) {
              mediaFilterCapsElement.release();
            }

          delete this._mediaElements[mediaFilter.adapterElementId];
          delete this._mediaElements[mediaFilterCaps.adapterElementId];

          return true;
        });
      } else {
        return false;
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async startRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this._mediaElements[sourceId];

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        source.record((err) => {
          if (err) {
            return reject(this._handleError(err));
          }
          return resolve();
        });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _stopRecording (sourceId) {
    return new Promise((resolve, reject) => {
      const source = this._mediaElements[sourceId];

      if (source == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      try {
        source.stopAndWait((err) => {
          if (err) {
            return reject(this._handleError(err));
          }
          return resolve();
        });
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async _transposeAndConnect(sourceId, sinkId) {
    return new Promise(async (resolve, reject) => {
      try {
        const source = this._mediaElements[sourceId];
        const sink = this._mediaElements[sinkId];
        Logger.info(LOG_PREFIX, "Transposing from", source.id, "| host", source.host.id,  "to", sink.id, "| host", sink.host.id);
        let sourceTransposer, sinkTransposer, sourceOffer, sinkAnswer;

        sourceTransposer = source.transposers[sink.host.id];

        if (sourceTransposer == null) {
          source.transposers[sink.host.id] = {};
          this._transposingQueue.push(source.host.id+source.id+sink.host.id);
          Logger.info(LOG_PREFIX, "Source transposer for", source.id, "to host", sink.host.id, "not found");
          sourceTransposer = await this._createElement(source.pipeline, C.MEDIA_TYPE.RTP);
          source.transposers[sink.host.id] = sourceTransposer;
          sourceOffer = await this.generateOffer(sourceTransposer.id);
          // TODO force codec based on source media
          let filteredOffer = SdpWrapper.filterByVideoCodec(sourceOffer, "H264");
          sourceOffer = SdpWrapper.convertToString(filteredOffer);
          this.balancer.incrementHostStreams(source.host.id, C.MEDIA_PROFILE.MAIN);

          Logger.info(LOG_PREFIX, "Sink transposer for pipeline", sink.pipeline.id, "for host", source.id, source.host.id, "not found");
          sink.pipeline.transposers[source.host.id+source.id] = sinkTransposer = await this._createElement(sink.pipeline, C.MEDIA_TYPE.RTP);
          sinkAnswer = await this.processOffer(sinkTransposer.id, SdpWrapper.nonPureReplaceServerIpv4(sourceOffer, source.host.ip));
          await this.processAnswer(sourceTransposer.id, SdpWrapper.nonPureReplaceServerIpv4(sinkAnswer, sink.host.ip));
          this.balancer.incrementHostStreams(sink.host.id, C.MEDIA_PROFILE.MAIN);
          this._connect(source, sourceTransposer);
          this._connect(sinkTransposer, sink);
          this._transposingQueue = this._transposingQueue.filter(sm => sm !== source.host.id + source.id + sink.host.id);
          this.emit(C.ELEMENT_TRANSPOSED + source.host.id + source.id + sink.host.id);
          return resolve();
        } else {
          if (this._transposingQueue.includes(source.host.id + source.id + sink.host.id)) {
            this.once(C.ELEMENT_TRANSPOSED + source.host.id + source.id + sink.host.id, () => {
              sinkTransposer = sink.pipeline.transposers[source.host.id+source.id];
              this._connect(sinkTransposer, sink);
              return resolve();
            });
          } else {
            sinkTransposer = sink.pipeline.transposers[source.host.id+source.id];
            this._connect(sinkTransposer, sink);
            return resolve();
          }
        }
      } catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  async _connect (source, sink, type = 'ALL') {
    return new Promise((resolve, reject) => {
      try {
        if (source == null || sink == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }

        Logger.info(LOG_PREFIX, "Adapter elements to be connected", JSON.stringify({
          sourceId: source.id,
          sinkId: sink.id,
          connectionType: type,
        }));

        switch (type) {
          case C.CONNECTION_TYPE.ALL:
            source.connect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.AUDIO:
            source.connect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });

          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
            source.connect(sink, 'VIDEO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  connect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      const source = this._mediaElements[sourceId];
      const sink = this._mediaElements[sinkId];

      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      const shouldTranspose = source.host.id !== sink.host.id;

      try {
        if (shouldTranspose) {
          await this._transposeAndConnect(sourceId, sinkId);
          return resolve();
        } else {
          await this._connect(source, sink, type);
          resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  async _disconnect (source, sink, type) {
    return new Promise((resolve, reject) => {
      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }
      try {
        switch (type) {
          case C.CONNECTION_TYPE.ALL:
            source.disconnect(sink, (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          case C.CONNECTION_TYPE.AUDIO:
            source.disconnect(sink, 'AUDIO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });

          case C.CONNECTION_TYPE.VIDEO:
          case C.CONNECTION_TYPE.CONTENT:
            source.disconnect(sink, 'VIDEO', (error) => {
              if (error) {
                return reject(this._handleError(error));
              }
              return resolve();
            });
            break;

          default:
            return reject(this._handleError(ERRORS[40107].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  disconnect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      const source = this._mediaElements[sourceId];
      const sink = this._mediaElements[sinkId];

      if (source == null || sink == null) {
        return reject(this._handleError(ERRORS[40101].error));
      }

      const isTransposed = source.host.id !== sink.host.id;

      try {
        if (isTransposed) {
          const transposedSink = sink.pipeline.transposers[source.host.id+source.id]
          await this._disconnect(transposedSink, sink, type);
          resolve();
        } else {
          await this._disconnect(source, sink, type);
          resolve();
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }


  stop (room, type, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "Releasing endpoint", elementId, "from room", room);
        const mediaElement = this._mediaElements[elementId];

        this._removeElementEventListeners(elementId);

        if (type === 'RecorderEndpoint') {
          await this._stopRecording(elementId);
        }

        if (type === C.MEDIA_TYPE.HUBPORT) {
            await this.destroyHubPort(elementId);
            return resolve();
        }

        if (type === C.MEDIA_TYPE.MCU) {
          await this.destroyRemainingMediaFilters(elementId);
        }

        if (mediaElement) {
          const pipeline = this._mediaPipelines[room][mediaElement.host.id];
          const hostId = mediaElement.host.id;

          delete this._mediaElements[elementId];

          if (mediaElement.transposers) {
            Object.keys(mediaElement.transposers).forEach(t => {
              setTimeout(() => {
                mediaElement.transposers[t].release();
                Logger.debug(LOG_PREFIX, "Releasing transposer", t, "for", elementId);
                this.balancer.decrementHostStreams(hostId, C.MEDIA_PROFILE.MAIN);
              }, 0);
            });
          }

          const sinkTransposersToRelease = Object.keys(this._mediaPipelines[room]).filter(ph => {
            if (this._mediaPipelines[room][ph] == null) {
              return false;
            }
            const keys = Object.keys(this._mediaPipelines[room][ph].transposers);
            let t = keys.includes(hostId+mediaElement.id)
            return t;
          });


          sinkTransposersToRelease.forEach(st => {
            this._mediaPipelines[room][st].transposers[hostId+mediaElement.id].release()
            this.balancer.decrementHostStreams(st, C.MEDIA_PROFILE.MAIN);
            delete this._mediaPipelines[room][st].transposers[hostId+mediaElement.id];
          });

          if (typeof mediaElement.release === 'function') {
            mediaElement.release(async (error) => {
              if (error) {
                return reject(this._handleError(error));
              }

              if (pipeline) {
                pipeline.activeElements--;

                Logger.info(LOG_PREFIX, "Pipeline has a total of", pipeline.activeElements, "active elements");
                if (pipeline.activeElements <= 0) {
                  await this._releasePipeline(room, hostId);
                }
              }

              return resolve();
            });
          } else {
            // Element is not available for release anymore, so it's pipeline
            // was probably already released altogether. Just resolve the call.
            return resolve();
          }
        }
        else {
          Logger.warn(LOG_PREFIX, "Media element", elementId, "could not be found to stop");
          return resolve();
        }
      }
      catch (err) {
        this._handleError(err);
        resolve();
      }
    });
  }

  _checkForMDNSCandidate (candidate) {
    // Temporary stub for ignoring mDNS .local candidates. It'll just check
    // for it and make the calling procedure resolve if it's a mDNS.
    // The commented code below is a general procedure to enabling mDNS
    // lookup. We just gotta find a proper librabry or way to do it once the
    // time is right

    const mDNSRegex = /([\d\w-]*)(.local)/ig
    if (candidate.match(/.local/ig)) {
      return true;
    }
    return false;

    //const parsedAddress = mDNSRegex.exec(candidate)[1];
    //Logger.trace(LOG_PREFIX, "Got a mDNS obfuscated candidate with addr", parsedAddress);
    //dns.lookup(parsedAddress, (e, resolvedAddress) => {
    //  if (e) {
    //    Logger.trace(LOG_PREFIX, "mDNS not found with error", e);
    //    return reject(ERRORS[40401].error);
    //  }

    //  candidate.replace(mDNSRegex,  resolvedAddress);

    //  return resolve(candidate);
  }

  addIceCandidate (elementId, candidate) {
    return new Promise(async (resolve, reject) => {
      const mediaElement = this._mediaElements[elementId];
      try {
        if (mediaElement  && candidate) {
          if (this._checkForMDNSCandidate(candidate.candidate)) {
            Logger.trace(LOG_PREFIX, "Ignoring a mDNS obfuscated candidate", candidate.candidate);
            return resolve();
          }

          mediaElement.addIceCandidate(candidate, (error) => {
            if (error) {
              return reject(this._handleError(error));
            }
            Logger.trace(LOG_PREFIX, "Added ICE candidate for => ", elementId, candidate);
            return resolve();
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  gatherCandidates (elementId) {
    Logger.info(LOG_PREFIX, 'Gathering ICE candidates for ' + elementId);

    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];
        if (mediaElement == null) {
          return reject(this._handleError(ERRORS[40101].error));
        }
        mediaElement.gatherCandidates((error) => {
          if (error) {
            return reject(this._handleError(error));
          }
          Logger.info(LOG_PREFIX, 'Triggered ICE gathering for ' + elementId);
          return resolve();
        });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  setInputBandwidth (element, min, max) {
    if (element) {
      element.setMinVideoRecvBandwidth(min);
      element.setMaxVideoRecvBandwidth(max);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBandwidth (element, min, max) {
    if (element) {
      element.setMinVideoSendBandwidth(min);
      element.setMaxVideoSendBandwidth(max);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  setOutputBitrate (element, bitrate) {
    if (element) {
      element.setOutputBitrate(bitrate);
    } else {
      throw (this._handleError(ERRORS[40101].error));
    }
  }

  processOffer (elementId, sdpOffer, params = {})  {
    const { replaceIp } = params;
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];
        if (mediaElement) {
          Logger.trace(LOG_PREFIX, `Processing ${elementId} offer`, { offer: sdpOffer });
          mediaElement.processOffer(sdpOffer, (error, answer) => {
            if (error) {
              return reject(this._handleError(error));
            }

            if (replaceIp) {
              answer = answer.replace(/(IP4\s[0-9.]*)/g, 'IP4 ' + mediaElement.host.ip);
            }

            return resolve(answer);
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  processAnswer (elementId, answer) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];
        if (mediaElement) {
          Logger.trace(LOG_PREFIX, `Processing ${elementId} answer`, { answer });
          mediaElement.processAnswer(answer, (error, rAnswer) => {
            if (error) {
              return reject(this._handleError(error));
            }
            return resolve();
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  generateOffer (elementId, filterOptions = []) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];
        if (mediaElement) {
          mediaElement.generateOffer((error, offer) => {
            if (error) {
              return reject(this._handleError(error));
            }
            filterOptions.forEach(({ reg, val }) => {
              offer = offer.replace(reg, val);
            });
            Logger.trace(LOG_PREFIX, `Generated offer for ${elementId}`, { offer });
            return resolve(offer);
          });
        }
        else {
          return reject(this._handleError(ERRORS[40101].error));
        }
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  requestKeyframe (elementId) {
    return new Promise((resolve, reject) => {
      try {
        const mediaElement = this._mediaElements[elementId];

        if (typeof mediaElement.requestKeyframe !== 'function') {
          throw this._handleError({
            ...C.ERROR.MEDIA_INVALID_OPERATION,
            details: "KURENTO_REQUEST_KEYFRAME_NOT_IMPLEMENTED"
          });
        }

        mediaElement.requestKeyframe((error) => {
          if (error) {
            return reject(this._handleError(error));
          }

          return resolve();
        });

      } catch (err) {
        return reject(this._handleError(error));
      }
    });
  }

  dtmf (elementId, tone) {
    throw this._handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: "KURENTO_DTMF_NOT_IMPLEMENTED"
    });
  }

  trackMediaState (elementId, type) {
    switch (type) {
      case C.MEDIA_TYPE.URI:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ENDOFSTREAM, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.WEBRTC:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.ICE, elementId);
        break;

      case C.MEDIA_TYPE.RTP:
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.CHANGED, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      case C.MEDIA_TYPE.RECORDING:
        this.addMediaEventListener(C.EVENT.RECORDING.STOPPED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.PAUSED, elementId);
        this.addMediaEventListener(C.EVENT.RECORDING.STARTED. elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_IN, elementId);
        this.addMediaEventListener(C.EVENT.MEDIA_STATE.FLOW_OUT, elementId);
        break;

      default: return;
    }
    return;
  }

  _shouldSendCandidate (candidate) {
    if (ALLOWED_CANDIDATE_IPS == null || ALLOWED_CANDIDATE_IPS.length <= 0) {
      return true;
    }

    return ALLOWED_CANDIDATE_IPS.some(ip => candidate.includes(ip));
  }

  addMediaEventListener (eventTag, elementId) {
    const mediaElement = this._mediaElements[elementId];
    let event = {};
    try {
      if (mediaElement) {
        Logger.debug(LOG_PREFIX, 'Adding media state listener [' + eventTag + '] for ' + elementId);
        mediaElement.on(eventTag, (e) => {
          const timestampUTC = Date.now();
          const timestampHR = Util.hrTime();
          switch (eventTag) {
            case C.EVENT.MEDIA_STATE.ICE:
              if (!this._shouldSendCandidate(e.candidate.candidate)) {
                return;
              }
              event.candidate = KMS_CLIENT.getComplexType('IceCandidate')(e.candidate);
              event.elementId = elementId;
              event.timestampUTC = timestampUTC;
              event.timestampHR = timestampHR;
              this.emit(C.EVENT.MEDIA_STATE.ICE+elementId, event);
              break;
            default:
              event.state = { name: eventTag, details: e.state };
              event.elementId = elementId;
              event.timestampUTC = timestampUTC;
              event.timestampHR = timestampHR;
              this.emit(C.EVENT.MEDIA_STATE.MEDIA_EVENT+elementId, event);
          }
        });
      }
    }
    catch (err) {
      err = this._handleError(err);
    }
  }

  _removeElementEventListeners (elementId) {
    const eventsToRemove = C.EVENT.ADAPTER_EVENTS.map(p => `${p}${elementId}`);
    Logger.trace(LOG_PREFIX, "Removing all event listeners for", elementId);
    eventsToRemove.forEach(e => {
      this.removeAllListeners(e);
    });
  }

  _destroyElementsFromHost (hostId) {
    try {
      Object.keys(this._mediaPipelines).forEach(r => {
        if (this._mediaPipelines[r][hostId]) {
          delete this._mediaPipelines[r][hostId];
        }
      });

      Object.keys(this._mediaElements).forEach(mek => {
        Object.keys(this._mediaElements[mek].transposers).forEach(t => {
          if (t === hostId) {
            delete this._mediaElements[mek].transposers[t];
          }
        });

        if (this._mediaElements[mek].host.id === hostId) {
          delete this._mediaElements[mek];
        }
      });
    } catch (e) {
      Logger.error(e);
    }
  }

  _handleError(err) {
    let { message: oldMessage , code, stack } = err;
    let message;

    Logger.trace(LOG_PREFIX, 'Error stack', err);

    if (code && code >= C.ERROR.MIN_CODE && code <= C.ERROR.MAX_CODE) {
      return err;
    }

    const error = ERRORS[code]? ERRORS[code].error : null;

    if (error == null) {
      switch (oldMessage) {
        case "Request has timed out":
          ({ code, message }  = C.ERROR.MEDIA_SERVER_REQUEST_TIMEOUT);
          break;

        case "Connection error":
          ({ code, message } = C.ERROR.CONNECTION_ERROR);
          break;

        default:
          ({ code, message } = C.ERROR.MEDIA_SERVER_GENERIC_ERROR);
      }
    }
    else {
      ({ code, message } = error);
    }

    // Checking if the error needs to be wrapped into a JS Error instance
    if (!isError(err)) {
      err = new Error(message);
    }

    err.code = code;
    err.message = message;
    err.details = oldMessage;
    err.stack = stack

    Logger.debug(LOG_PREFIX, 'Media Server returned an', err.code, err.message);
    return err;
  }
};
