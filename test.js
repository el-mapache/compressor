/** Element creator **/
const Element = (() => {
  const listeners = ['change', 'input', 'click'];

  const childFromType = child =>
    typeof child === 'string' ? document.createTextNode(child) : child;

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
          if (!child) continue;

          el.appendChild(childFromType(child));
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
    clear: {
      value: function() {
        this.getState(this.namespace).then(state => {
          if (state) {
            localStorage.setItem(this.namespace, JSON.stringify(this.defaultState));
          }
        });
      }
    },

    update: {
      value: function(lastState, nextState) {
        localStorage.setItem(this.namespace, JSON.stringify(nextState));
        this.handlers.forEach(handler => handler(lastState, nextState));
      },
      writable: false,
      configurable: false
    },

    getState: {
      value: function get(key = null) {
        return new Promise((resolve, reject) => {
          jsonParse(localStorage.getItem(this.namespace)).then(result => {
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

const handleChange = storage => event => {
  const { target } = event;

  storage.setState({ [target.id]: Number(target.value) });
};

const Compressor = (() => {
  function _Compressor(audioContext, storage) {
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

    set(key, value) {
      if (key === 'gain') {
        this.gain.gain.value = value;
        return;
      }

      if (!this.compressor[key]) return;

      this.compressor[key].value = value;
    },

    setState(changes) {
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
    resolve(context.createMediaElementSource(document.getElementById(elementID)));
  });
}

function patch(audioSourcePromise, audioGraph = [], destination, processCallback = false) {
  audioSourcePromise.then((source) => {
    const graph = audioGraph.reduce((val, item) => {
      val.connect(item);
      return item;
    }, source);

    if (processCallback && typeof processCallback === 'function') {
      processor.onaudioprocess = processCallback;
      graph.connect(processor)
      processor.connect(destination);
    }

    graph.connect(destination);
  });
}

const buildRangeInput = (descriptor) => {
  const input = Element.input(null, descriptor);
  const label = Element.label([
      descriptor.name,
      input,
      Element.span(null, { className: `range-value ${descriptor.name}`})
    ], { htmlFor: descriptor. name });

  return Element.div([ label ], { className: 'app' });
};

const render = tree => document.body.appendChild(tree);

const audioContext = new AudioContext();
const STORAGE_NAMESPACE = 'sb-compressor';
const state = {
  threshold: -40,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
  knee: 20,
  gain: 1,
  enabled: true
};
const storage = localStorageAdapter(STORAGE_NAMESPACE, state);
const changeHandler = handleChange(storage);
const processor = audioContext.createScriptProcessor(1024, 1, 1);
let reduction;
let outputMeter;
let meterHeight;

const dbfs = (summedAudio, sampleLength) => {
  const rms = Math.sqrt(summedAudio / (sampleLength / 2));
  return 20 * (Math.log(rms) / Math.log(10));
};

const onAudioProcess = function (compressor, audioEvent) {
  const buffer = audioEvent.inputBuffer.getChannelData(0);
  const length = buffer.length;
  let sum = 0;

  for (let i = 0; i < length; i++) {
    const sample = buffer[i];
    sum += sample * sample;
  }

  drawOutput(dbfs(sum, length));
  drawReduction(compressor.reduction)
}

const drawReduction = function(decibels) {
  const decibelsFixed = decibels.toFixed(2);

  if (!Math.abs(Math.round(decibels))) {
    reduction.style.height = 0;
  } else {
    const height = Math.abs(decibels);
    reduction.style.height = `${height}px`;
  }
}

const drawOutput = function(decibels) {
  if (!isFinite(decibels)) {
    outputMeter.style.height = 0;
  } else {
    let height = meterHeight - 20 + (decibels * 5);

    if (height > 190) height = 190;

    outputMeter.style.height = `${height}px`;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  let active = true;
  const source = HTMLAudioSource(audioContext, 'audio');
  const compressor = Compressor(audioContext, storage);

  storage.getState().then(currentState => {
    let nextState;

    nextState = currentState === null ? state : currentState;

    const inputDescriptors = [
      { name: 'threshold', value: nextState.threshold, min: '-100', max: '0', step: '1', type: 'range', id: 'threshold', input: changeHandler, 'data-tooltip': '' },
      { name: 'ratio', value: nextState.ratio, min: '1', max: '20', step: '1', type: 'range', id: 'ratio', input: changeHandler, 'data-tooltip': '' },
      { name: 'attack', value: nextState.attack, min: '0', max: '1', step: '0.001', type: 'range', id: 'attack', input: changeHandler, 'data-tooltip': '' },
      { name: 'release', value: nextState.release, min: '0', max: '1', step: '0.05', type: 'range', id: 'release', input: changeHandler, 'data-tooltip': '' },
      { name: 'knee', value: nextState.knee, min: '0', max: '40', step: '1', type: 'range', id: 'knee', input: changeHandler, 'data-tooltip': '' },
      { name: 'gain', value: nextState.gain, min: '0', max: '20', step: '1', type: 'range', id: 'gain', input: changeHandler, 'data-tooltip': '' }
    ];

    storage.subscribe(state => {
      Object.keys(state).forEach(key => {
        const value = state[key];
        const node = document.querySelector(`.${key}`);

        if (node) {
          node.innerText = value;
        }
      });
    });

    render(Element.div(inputDescriptors.map(d => {
      return buildRangeInput(d);
    })));

    storage.setState(nextState);
  });

  reduction = document.getElementById('reduction');
  outputMeter = document.getElementById('output-meter');
  meterHeight = Number(document.defaultView.getComputedStyle(document.querySelector('.meter-container'), null).getPropertyValue('max-height').split('px')[0]);

  source.then((s) => {
    // We have to manually disconnect everything to stop the compressor from functioning,
    // then reconnect the source to the destination.
    // The process is reversed when the compressor is toggled back on
    document.getElementById('toggle').addEventListener('click', (event) => {
      if (active) {
        compressor.node.disconnect(audioContext.destination);
        compressor.node.disconnect(processor);
        processor.disconnect(audioContext.destination);
        s.disconnect(compressor.node);
        s.connect(audioContext.destination);
        storage.setState('enabled', false)
        document.getElementById('status').innerText = 'disabled';
        active = false;
      } else {
        s.disconnect(audioContext.destination);
        s.connect(compressor.node);
        compressor.node.connect(audioContext.destination);
        compressor.node.connect(processor);
        processor.connect(audioContext.destination);
        storage.setState('enabled', true);
        document.getElementById('status').innerText = 'enabled';
        active = true;
      }
    });
    patch(source, [ compressor.node, compressor.gain ], audioContext.destination, onAudioProcess.bind(null, compressor));
  });

  document.getElementById('clear-settings').addEventListener('click', () => {

  });
});
