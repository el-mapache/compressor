const UNITS = 'px';
const dampingFactor = .8;
// represents the bottom of the output scale (-60 dB) and the top
// of the reduction scale (+60dB)
// The actual compressor reaches values slightly above and below this,
// but this approximation is sufficient
const floor = 60;
// Represents the amount of headroom after zero in the output meter
const ceiling = 20;

let playing = false;

/** Element creator **/
const Element = (() => {
  const listeners = ['change', 'input', 'click'];

  const childFromType = child =>
    typeof child === 'string' || typeof child === 'number' ? document.createTextNode(child) : child;

  const normalizeChildren = children =>
    Array.isArray(children) ? children : [ children ];

  return new Proxy({}, {
    get(target, property, receiver) {
      return (children, attrs) => {
        const el = document.createElement(property);
        const normalizedChildren = normalizeChildren(children);

        for (let attr in attrs) {
          if (typeof attrs[attr] === undefined || !attrs[attr]) {
            continue;
          }

          if (listeners.indexOf(attr) !== -1) {
            el.addEventListener(attr, attrs[attr]);
          } else {
            if (attr === 'className' && attrs[attr]) {
              el.setAttribute('class', attrs[attr]);
            } else if (attr === 'htmlFor') {
              el.setAttribute('for', attrs[attr]);
            } else {
              el.setAttribute(attr, attrs[attr]);
            }
          }
        }

        for (let child of normalizedChildren) {
          if (child) {
            el.appendChild(childFromType(child));
          } else {
            continue;
          }
        }

        return el;
      };
    }
  });
})();

const jsonParse = (maybeJson) => {
  return new Promise((resolve, reject) => {
    try {
      resolve(JSON.parse(maybeJson));
    } catch(error) {
      resolve({});
    }
  });
}

const Storage = (namespace, defaultState) => {
  return Object.create(Object.prototype, {
    defaultState: {
      value: defaultState,
      writable: false,
      configurable: false
    },
    namespace: {
      value: namespace,
      writable: false,
      configurable: false
    },
    handlers: {
      value: [],
      writable: true
    }
  });
};

const localStorageAdapter = (namespace, defaultState) => {
  return Object.create(Storage(namespace, defaultState), {
    reset: {
      value: function() {
        return this.getState().then(_ => {
          localStorage.setItem(this.namespace, JSON.stringify(this.defaultState));
          return this.defaultState;
        });
      }
    },

    update: {
      value: async function(lastState, nextState) {
        const state = await this.getState();
        const finalState = Object.assign({}, state, nextState);

        localStorage.setItem(this.namespace, JSON.stringify(finalState));
        this.handlers.forEach(handler => handler(lastState, finalState));
      },
      writable: false,
      configurable: false
    },

    getState: {
      value: function get(key = null) {
        return new Promise((resolve, reject) => {
          const appState = localStorage.getItem(this.namespace);

          return jsonParse(appState).then(result => {
            if (!key) {
              resolve(result);
            } else {
              resolve(result[key]);
            }
          });
        });
      }
    },

    setState: {
      value: function set(key, value) {
        this.getState().then(lastState => {
          if (typeof key === 'object') {
            // the entire state is getting overwritten
            this.update(lastState, key);
          } else if (lastState[key] === value) {
            // No change, don't do anything
            return;
          } else {
            // Copy the old state, update the specific key/value, emit old and new states
            const nextState = Object.assign({}, lastState);
            nextState[key] = value;

            this.update(lastState, nextState);
          }
        });
      }
    },

    subscribe: {
      value: function subscribe(callback) {
        if (this.handlers.indexOf(callback) === -1) {
          this.handlers.push(callback);
        }
      }
    }
  });
};

const Compressor = (() => {
  function _Compressor(audioContext, storage) {
    this.context = audioContext;
    this.node = audioContext.createDynamicsCompressor();
    this.gain = audioContext.createGain();
    this.setState = this.setState.bind(this);
    storage.subscribe(this.setState);
  }

  _Compressor.prototype = {
    get compressor() {
      return this.node;
    },

    get threshold() {
      return this.compressor.threshold;
    },

    get ratio() {
      return this.compressor.ratio;
    },

    get attack() {
      return this.compressor.attack;
    },

    get release() {
      return this.compressor.release;
    },

    get knee() {
      return this.compressor.knee;
    },

    get reduction() {
      return this.compressor.reduction;
    },

    adjustValue(param, value) {
      if (value < param.minValue) {
        realValue = param.minValue;
      } else if (param.maxValue === 0 && value >= 0) {
        realValue = -0.001;
      } else {
        realValue = value;
      }

      param.exponentialRampToValueAtTime(realValue, this.context.currentTime);
    },

    set(key, value) {
      const param = key === 'gain' ? this.gain.gain : this.compressor[key];

      if (param) {
        this.adjustValue(param, value);
      }
    },

    setState(prevState, nextState) {
      // storage obj should be reporting what changed maybe?
      const changes = Object.keys(nextState).reduce((memo, key) => {
        const param = nextState[key];

        if (param !== prevState[key]) {
          memo[key] = param;
        }

        return memo;
      }, {});

      for (let prop in changes) {
        this.set(prop, changes[prop]);
      }
    }
  };

  return function(ctx, storage) {
    return new _Compressor(ctx, storage);
  };
})();

function HTMLAudioSource(context, elementID) {
  return new Promise(function(resolve, reject) {
    const node = document.getElementById(elementID);

    if (!node) {
      reject(`Node with ID ${elementID} does not exist.`);
    }

    try {
      resolve(context.createMediaElementSource(node));
    } catch(error) {
      reject('Error creating media element source: ', error.message);
    }
  });
}

function patch(source, audioGraph = [], destination, processCallback = false) {
  const graph = audioGraph.reduce((val, item) => {
    val.connect(item);
    return item;
  }, source);

  // Add onaudioprocess callback to the processor, and connect the graph to the processor
  // so that transformed audio can be evaluated properly
  // TODO: encapsulate maybe
  if (processCallback && typeof processCallback === 'function') {
    processor.onaudioprocess = processCallback;
    graph.connect(processor)
    processor.connect(destination);
  }

  graph.connect(destination);
}

const buildRangeInput = (descriptor) => {
  const input = Element.input(null, descriptor);
  const label = Element.label([
      descriptor.name,
      input,
      Element.span(descriptor.value, { className: `range-value ${descriptor.name}` })
    ], { htmlFor: descriptor. name });

  return Element.div([ label ]);
};

const render = (target = document.body, tree) => {
  const oldNode = target.children && target.children[0] || null;
  const nextNode = tree;

  if (!oldNode) {
    target.appendChild(nextNode);
  } else {
    target.replaceChild(nextNode, oldNode);
  }
};

const audioContext = new AudioContext();
const STORAGE_NAMESPACE = 'sb-compressor';
const state = {
  threshold: -40,
  ratio: 12,
  attack: 0.1,
  release: 0.1,
  knee: 20,
  gain: 1,
  enabled: true
};
const storage = localStorageAdapter(STORAGE_NAMESPACE, state);
const processor = audioContext.createScriptProcessor(1024, 1, 1);

const RangeInputController = (el, storage) => {
  const element = el;
  const handleChange = storage => event => {
    const { target } = event;

    storage.setState({ [target.id]: Number(target.value) });
  };
  const changeHandler = handleChange(storage);
  const generateInputState = state => {
    return [
      { name: 'threshold', value: state.threshold, min: '-100', max: '0', step: '1', type: 'range', id: 'threshold', input: changeHandler },
      { name: 'ratio', value: state.ratio, min: '1', max: '20', step: '1', type: 'range', id: 'ratio', input: changeHandler },
      { name: 'attack', value: state.attack, min: '0.1', max: '1', step: '0.1', type: 'range', id: 'attack', input: changeHandler },
      { name: 'release', value: state.release, min: '0.1', max: '1', step: '0.1', type: 'range', id: 'release', input: changeHandler },
      { name: 'knee', value: state.knee, min: '0.001', max: '40', step: '1', type: 'range', id: 'knee', input: changeHandler },
      { name: 'gain', value: state.gain, min: '0', max: '10', step: '1', type: 'range', id: 'gain', input: changeHandler }
    ];
  };

  return {
    render(state) {
      const htmlTree = generateInputState(state)
        .map(descriptor => buildRangeInput(descriptor));
      const appHtml = Element.div(htmlTree);

      render(element, appHtml);
    }
  }
};

const inputController = RangeInputController(document.getElementById('input-controls'), storage);

let reduction;
let outputMeter;
let meterHeight;
let heightBeforePeak;

const dbfs = (summedAudio, sampleLength) => {
  const rms = Math.sqrt(summedAudio / (sampleLength / 2));
  return 20 * Math.log10(rms);
};

const clamp = (value, max) => value > max ? max : value;

const onAudioProcess = function (compressor, audioEvent) {
  const buffer = audioEvent.inputBuffer.getChannelData(0);
  const length = buffer.length;
  const sum = buffer.reduce((sum, sample) => sum + (sample * sample), 0);

  if (playing) {
    drawOutput(dbfs(sum, length));
    drawReduction(compressor.reduction);
  } else {
    drawOutput(0);
    drawReduction(0);
  }
}

const drawReduction = function(decibels) {
  const dBFixed = decibels.toFixed(2);

  /**
   * Occasionally, the `reduction` property will report really low values,
   * like -0.000001. We floor and flip the sign to make sure the draw actually
   * needs to happen. This seems to happen mostly when no audio is coming through
   */
  if (!(~(dBFixed | 0) + 1)) {
    reduction.style.height = 0;
  } else {
    const height = clamp(Math.abs(meterHeight * (dBFixed / floor)), meterHeight);
    reduction.style.height = `${height}${UNITS}`;
  }
}

const drawOutput = function(decibels) {
  const decibelsFixed = decibels.toFixed(2);

  if (!isFinite(decibels) || !decibels) {
    outputMeter.style.height = 0;
  } else {
    const floorOrCeiling = decibels > 0 ? ceiling : floor;
    const height = clamp(heightBeforePeak + (decibels / floorOrCeiling) * heightBeforePeak, meterHeight);

    outputMeter.style.height = `${height}${UNITS}`;
  }
};

document.addEventListener('DOMContentLoaded', async function onContentLoad() {
  let active = true;
  const source = await HTMLAudioSource(audioContext, 'audio');
  const compressor = Compressor(audioContext, storage);

  storage.getState().then(currentState => {
    let nextState;

    nextState = currentState === null ? state : currentState;

    storage.subscribe((lastState, state) => {
      Object.keys(state).forEach(key => {
        const value = state[key];
        const node = document.querySelector(`.${key}`);

        if (node) {
          node.innerText = value;
        }
      });
    });

    inputController.render(nextState);
    compressor.setState({}, nextState);

    storage.setState(nextState);
  });

  reduction = document.getElementById('reduction');
  outputMeter = document.getElementById('output-meter');
  meterHeight = Number(document.defaultView.getComputedStyle(document.querySelector('.meter-container'), null).getPropertyValue('max-height').split('px')[0]);
  heightBeforePeak = meterHeight * dampingFactor;
  // We have to manually disconnect everything to stop the compressor from functioning,
  // then reconnect the source to the destination.
  // The process is reversed when the compressor is toggled back on
  document.getElementById('toggle').addEventListener('click', (event) => {
    if (active) {
      compressor.gain.disconnect(audioContext.destination);
      compressor.gain.disconnect(processor);
      processor.disconnect(audioContext.destination);
      source.disconnect(compressor.node);
      source.connect(audioContext.destination);
      storage.setState('enabled', false)
      document.getElementById('status').innerText = 'disabled';
      active = false;
    } else {
      source.disconnect(audioContext.destination);
      patch(source, [ compressor.node, compressor.gain ], audioContext.destination, onAudioProcess.bind(null, compressor));
      storage.setState('enabled', true);
      document.getElementById('status').innerText = 'enabled';
      active = true;
    }
  });

  patch(source, [ compressor.node, compressor.gain ], audioContext.destination, onAudioProcess.bind(null, compressor));

  const audioEl = document.querySelector('audio');
  const togglePlaying = () => {
    playing = !playing ? true : false;
  }

  audioEl.addEventListener('play', togglePlaying);
  audioEl.addEventListener('pause', togglePlaying);

  document.getElementById('clear-settings').addEventListener('click', () => {
    storage.reset().then(state => inputController.render(state));
  });
});
