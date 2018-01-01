let playing = false;

const getDOMNode = (maybeSelector) => {
  return typeof maybeSelector === 'string' ?
    document.querySelector(maybeSelector)  :
    maybeSelector;
};

const getStylePropOfElement = (selector, prop) => {
  const el = getDOMNode(selector);

  return document.defaultView.getComputedStyle(el).getPropertyValue(prop);
};

/** Element creator **/
const Element = (() => {
  const listeners = ['change', 'input', 'click', 'blur', 'focus'];

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
          let attribute = attr;
          let attributeValue = attrs[attr];

          if (typeof attributeValue === undefined) {
            attributeValue = '';
          }

          if (listeners.indexOf(attr) !== -1) {
            el.addEventListener(attr, attributeValue);
          } else {
            if (attr === 'className') {
              attribute = 'class';
            } else if (attr === 'htmlFor') {
              attribute = 'for';
            }

            el.setAttribute(attribute, attributeValue);
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
        return this.getState().then(() => {
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
    get out() {
      return this.gain;
    },

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
  return new Promise((resolve, reject) => {
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

const buildRangeInput = (descriptor) => {
  const input = Element.input(null, descriptor);
  const inputValue = Element.span(descriptor.value, { className: `range-value ${descriptor.name}` });
  const label = Element.label([
      descriptor.name,
      input,
      inputValue,
    ], { htmlFor: descriptor. name });

  return Element.div([ label ]);
};

const render = (target = document.body, tree) => {
  const oldNode = (target.children && target.children[0]) || null;
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
      { name: 'gain', value: state.gain, min: '0.001', max: '10', step: '1', type: 'range', id: 'gain', input: changeHandler }
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

const dbfs = (summedAudio, sampleLength) => {
  const rms = Math.sqrt(summedAudio / (sampleLength / 2));
  return 20 * Math.log10(rms);
};

const clamp = (value, max) => value > max ? max : value;

document.addEventListener('DOMContentLoaded', async function onContentLoad() {
  let active = true;
  const source = await HTMLAudioSource(audioContext, 'audio');
  const compressor = Compressor(audioContext, storage);

  const outputMeterInst = new OutputMeter('#output-meter', {
    intervals: [5, 0, -10, -15, -20, -25, -35, -45, -55],
    legend: 'output',
  });

  const reductionMeterInst = new ReductionMeter('#reduction-meter', {
    intervals: [0, 10, 15, 20, 25, 35, 45, 55, 60],
    legend: 'reduction',
    meterAttrs: {
      className: ['invert']
    }
  });

  const onAudioProcess = compressor => (audioEvent) => {
    const buffer = audioEvent.inputBuffer.getChannelData(0);
    const length = buffer.length;
    const sum = buffer.reduce((sum, sample) => sum + (sample * sample), 0);

    if (active) {
      reductionMeterInst.drawLevel(compressor.reduction);
    } else {
      reductionMeterInst.drawLevel(0);
    }

    if (playing) {
      outputMeterInst.drawLevel(dbfs(sum, length));
    } else {
      outputMeterInst.drawLevel(0);
    }
  }

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

  document.getElementById('toggle').addEventListener('click', (event) => {
    if (active) {
      active = false;
      compressorGraph.unpatchFrom(sourceAudioNode);
      storage.setState('enabled', false)
      document.getElementById('status').innerText = 'disabled';
    } else {
      compressorGraph.patchInto(sourceAudioNode);
      storage.setState('enabled', true);
      document.getElementById('status').innerText = 'enabled';
      active = true;
    }
  });

  // compressor chain
  const compressorGraph = new AudioGraph();

  const processFn = onAudioProcess(compressor);
  processor.onaudioprocess = processFn;

  compressorGraph.chain([
    {
      name: 'compressor',
      node: compressor.node,
    },
    {
      name: 'gain',
      node: compressor.out
    }
  ]);

  const sourceAudioNode = new AudioNode({ name: 'source', node: source });
  const processorAudioNode = new AudioNode({ name: 'processor', node: processor });
  const destinationAudioNode = new AudioNode({ name: 'output', node: audioContext.destination });

  compressorGraph.insertAudioNode(sourceAudioNode);
  compressorGraph.outputToAudioNode(processorAudioNode);
  compressorGraph.outputToAudioNode(destinationAudioNode);
  processorAudioNode.connect(destinationAudioNode.node);

  const audioEl = document.querySelector('audio');
  /**
   * Time in MS that the code should delay the audio before hitting the signal chain
   * This is useful when 'crushing' the source material, like when using the compressor
   * as an extreme limiter.  The web audio dynamics node, while pretty fast, is not fast enough to
   * apply very hard limiting to plosives.
   *
   * This will affect a gentle fade in, at the cost of hearing the sound immediately.
   * Something like this might be better installed at the end of your signal chain
   */
  const fadeInBuffer = 160; // TODO: Make this opt in, upon initialization of plug-in


  const togglePlaying = () => {
    storage.getState().then((state) => {
      storage.setState({
        gain: 0.0001
      });
      playing = !playing ? true : false;

      setTimeout(() => {
        storage.setState({ gain: state.gain})
      }, fadeInBuffer);
    });
  }

  audioEl.addEventListener('play', togglePlaying);
  audioEl.addEventListener('pause', togglePlaying);

  document.getElementById('clear-settings').addEventListener('click', () => {
    storage.reset().then(state => inputController.render(state));
  });
});

const meterDefaults = {
  meter: {
    // Represents the amount of headroom after zero in the output meter
    ceiling: 20,
    // represents the bottom of the output scale (-60 dB) and the top
    // of the reduction scale (+60dB)
    // The actual compressor reaches values slightly above and below this,
    // but this approximation is sufficient
    floor: 60,
    units: 'px',
    dampingFactor: 0.8,
  },
  intervals: [],
  legend: null,
  legendAttrs: {},
  meterAttrs: {},
};

class Meter {
  constructor(el, options = meterDefaults) {
    this.el = getDOMNode(el);
    this.options = { ...meterDefaults, ...options };

    this.render();

    this.meterHeight = Number(getStylePropOfElement(this.el, 'max-height').split('px')[0]);
    this.heightBeforePeak = this.meterHeight * this.options.meter.dampingFactor;
    this.meter = this.el.querySelector('.meter');
  }

  render() {
    const {
      intervals,
      legend,
      legendAttrs,
      meterAttrs,
    } = this.options

    const meterClasses = meterAttrs.className &&
      meterAttrs.className.join(' ');

    const intervalsNode = intervals.reduce((memo, interval) => {
      return memo.concat([
        Element.span([
          Element.br(),
          String(interval),
        ], { className: 'interval' })
      ]);
    }, []);

    const intervalsContainer = Element.div(intervalsNode, { className: 'meter-legend' });

    const meter = Element.div([
      Element.div(null, {
        className: `meter ${meterClasses}`,
      }),
    ], { className: 'meter-container' });

    const container = Element.div([
      Element.p(legend, legendAttrs || {}),
      meter,
      intervalsContainer,
    ]);

    this.el.appendChild(container);
  }
}

class OutputMeter extends Meter {
  constructor(el, options) {
    super(el, options);

    this.drawLevel = this.drawLevel.bind(this);
  }

  drawLevel(decibels) {
    const { ceiling, floor, units } = this.options.meter;
    const { meterHeight, heightBeforePeak } = this;
    const decibelsFixed = decibels.toFixed(2);

    if (!isFinite(decibels) || !decibels) {
      this.meter.style.height = 0;
    } else {
      const floorOrCeiling = decibels > 0 ? ceiling : floor;
      const height = clamp(heightBeforePeak + (decibels / floorOrCeiling) * heightBeforePeak, meterHeight);

      this.meter.style.height = `${height}${units}`;
    }
  }
}

class ReductionMeter extends Meter {
  constructor(el, options) {
    super(el, options);

    this.drawLevel = this.drawLevel.bind(this);
  }

  drawLevel(decibels) {
    const dBFixed = decibels.toFixed(2);
    const { meterHeight } = this;
    const { floor, units } = this.options.meter;

    /**
     * Occasionally, the `reduction` property will report really low values,
     * like -0.000001. We floor and flip the sign to make sure the draw actually
     * needs to happen. This seems to happen mostly when no audio is coming through
     */
    if (!(~(dBFixed | 0) + 1)) {
      this.meter.style.height = 0;
    } else {
      const height = clamp(Math.abs(meterHeight * (dBFixed / floor)), meterHeight);
      this.meter.style.height = `${height}${units}`;
    }
  }
}

class AudioNode {
  constructor({ node, name, next, prev }) {
    this.prev = prev || null;
    this.next = next || null;
    this.node = node
    this.name = name;
  }

  nextNode() {
    return this.next && this.next.node;
  }

  prevNode() {
    return this.prev && this.prev.node;
  }

  // connect and disconnect proxy to underlying AudioParam object
  connect(node) {
    return this.node.connect(node);
  }

  disconnect(node) {
    return this.node.disconnect(node);
  }
}

/// HEADS UP: AudioGraph and AudioNode are (basically?) the same thing.
// it seems like maybe i can rewrite these to share functionality
// TODO: rewrite these, the first pass was meh
const AudioGraph = (() => {
  const lookup = {};
  const outputs = [];

  return class {
    constructor() {
      this.head = null;
      this.tail = null;
      this.length = 0;
    }

    chain(nodes) {
      nodes.forEach((node) => {
        const audioNode = new AudioNode(node);

        this.push(audioNode);
      });

      let currentNode = this.head;

      while (currentNode) {
        const nextNode = currentNode.next;

        if (!nextNode) {
          break;
        }

        currentNode.connect(nextNode.node);
        currentNode = nextNode;
      }
    }

    push(node) {
      if (this.head === null) {
        this.head = node;
      }

      if (this.tail) {
        this.tail.next = node;
        node.prev = this.tail;
        this.tail = node;
      } else { // there is no tail
        // set the head's next pointer to the node being added
        this.head.next = node;

        // set the new node's previous pointer to the list head
        node.prev = this.head;

        // set the tail equal to the current node — the next pointer remains null
        this.tail = node;
      }

      this.length += 1;
      lookup[node.name] = node;
    }

    patch(node) {
      const nodeToPatch = typeof node === 'string' ? this.access(location) : node;

      nodeToPatch.prevNode().disconnect(nodeToPatch.nextNode());
      nodeToPatch.connect(nodeToPatch.nextNode());
    }

    unpatch(node) {
      const nodeToRemove = typeof node === 'string' ? this.access(location) : node;

      nodeToRemove.disconnect(nodeToRemove.nextNode());
      nodeToRemove.prevNode().connect(nodeToRemove.nextNode());
    }

    insertAudioNode(audioNode) {
      audioNode.connect(this.head.node);
    }

    outputToAudioNode(audioNode) {
      outputs.push(audioNode.node);

      this.tail.node.connect(audioNode.node);
    }

    patchInto(node) {
      outputs.forEach((audioNode) => {
        // this assumes that the node we want to patch into is connected to
        // the outputs, but that isnt necessarily the case.
        node.disconnect(audioNode);
        node.connect(this.head.node);
        this.tail.node.connect(audioNode);
      });
    }

    unpatchFrom(node) {
      outputs.forEach((audioNode) => {
        this.tail.node.disconnect(audioNode);
        node.connect(audioNode);
      });
    }

    access(nodeName) {
      return lookup[nodeName];
    }
  }
})();
