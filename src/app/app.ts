import {
  LEDElement,
  BuzzerElement,
  ServoElement,
  SSD1306Element,
  LCD1602Element,
  PushbuttonElement,
  SevenSegmentElement,
  NeopixelMatrixElement
} from '@wokwi/elements';

import { PinState } from 'avr8js';
import { buildHex } from "../shared/compile";
import { CPUPerformance } from '../shared/cpu-performance';
import { AVRRunner } from "../shared/execute";
import { formatTime } from "../shared/format-time";
import { EditorHistoryUtil } from '../shared/editor-history.util';
import { SSD1306Controller, SSD1306_ADDR_OTHER } from "../shared/ssd1306";
import { WS2812Controller } from "../shared/ws2812";
import { LCD1602Controller, LCD1602_ADDR } from "../shared/lcd1602";
import { I2CBus } from "../shared/i2c-bus";

// Using CommonJS modules
import * as ed from './editor'
import * as fs from "fs";

// Add events to the buttons
const compileButton = document.querySelector("#compile-button");
compileButton.addEventListener("click", compileAndRun);

const runButton = document.querySelector("#run-button");
runButton.addEventListener("click", onlyRun);

const stopButton = document.querySelector("#stop-button");
stopButton.addEventListener("click", stopCode);

const clearButton = document.querySelector("#clear-button");
clearButton.addEventListener("click", clearOutput);

const loadHexButton = document.querySelector("#loadhex-button");
loadHexButton.addEventListener("click", loadHex);

const fileInput = document.querySelector<HTMLInputElement>('#file-input');
fileInput.addEventListener('change', changeFileInput);

const statusLabel = document.querySelector("#status-label");
const statusLabelTimer = document.querySelector("#status-label-timer");
const statusLabelSpeed = document.querySelector("#status-label-speed");
const runnerOutputText = document.querySelector<HTMLElement>('#runner-output-text');

const serialInput = document.querySelector<HTMLInputElement>('#serial-input');
serialInput.addEventListener("keypress", serialKeyPress);

const serialSend = document.querySelector('#serial-send');
serialSend.addEventListener("click", serialTransmit);

// Set up LEDs
const leds = document.querySelectorAll<LEDElement>("wokwi-led");

// Set up the LCD1602
const lcd1602 = document.querySelector<LCD1602Element>(
  "wokwi-lcd1602"
);

// Set up the SSD1306
const ssd1306 = document.querySelector<SSD1306Element>(
  "wokwi-ssd1306"
);

// Set up the NeoPixel matrix
const matrix = document.querySelector<NeopixelMatrixElement>(
  "wokwi-neopixel-matrix"
);

const matrixPin = parseInt(matrix.getAttribute("pin"), 10);

// Set up the servo
const servo = document.querySelector<ServoElement>(
  "wokwi-servo"
);

// Set up the NeoPixel matrix
const buzzer = document.querySelector<BuzzerElement>(
  "wokwi-buzzer"
);

const buzzerPin = parseInt(buzzer.getAttribute("pin"), 10);

// Set up the push button
const pushButtons = document.querySelectorAll<PushbuttonElement & HTMLElement>(
  "wokwi-pushbutton"
);

// Set up the NeoPixel matrix
const segment = document.querySelector<SevenSegmentElement>(
  "wokwi-7segment"
);

// Set up the NeoPixel canvas
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");

const pixSize = canvas.height / matrix.rows;

// Set up toolbar
let runner: AVRRunner;

let board = 'uno';

let hasLEDsOnPortB: boolean;
let hasLEDsOnPortC: boolean;
let hasLEDsOnPortD: boolean;

// Set up press push buttons
pushButtons.forEach(function(button) {
  button.addEventListener('button-press', () => {
    const pushButtonPin = parseInt(button.getAttribute("pin"), 10);
    runner.portD.setPin(pushButtonPin, true);
  });
});

// Set up release push buttons
pushButtons.forEach(function(button) {
  button.addEventListener('button-release', () => {
    const pushButtonPin = parseInt(button.getAttribute("pin"), 10);
    runner.portD.setPin(pushButtonPin, false);
  });
});

function executeProgram(hex: string) {

  runner = new AVRRunner(hex);

  const cpuNanos = () => Math.round((runner.cpu.cycles / runner.frequency) * 1000000000);
  const cpuMillis = () => Math.round((runner.cpu.cycles / runner.frequency) * 1000);

  const cpuPerf = new CPUPerformance(runner.cpu, runner.frequency);

  const i2cBus = new I2CBus(runner.twi);

  const ssd1306Controller = new SSD1306Controller(cpuMillis);
  const lcd1602Controller = new LCD1602Controller(cpuMillis);
  const matrixController = new WS2812Controller(matrix.cols * matrix.rows);

  let lastState = PinState.Input;
  let lastStateCycles = 0;
  let lastUpdateCycles = 0;
  let ledHighCycles = 0;
  let previousMillis = 0;

  // Components feeding
  let feedLed = ed.getComponents().includes('wokwi-led');
  let feedBuzzer = ed.getComponents().includes('wokwi-buzzer');
  let feedNeoPixel = ed.getComponents().includes('wokwi-neopixel-matrix');
  let feed7Segment = ed.getComponents().includes('wokwi-7segment');
  let feedSsd1306 = ed.getComponents().includes('wokwi-ssd1306');
  let feedLcd1602 = ed.getComponents().includes('wokwi-lcd1602');

  // Enable as default
  hasLEDsOnPortB = true;
  hasLEDsOnPortC = true;
  hasLEDsOnPortD = true;

  i2cBus.registerDevice(SSD1306_ADDR_OTHER, ssd1306Controller);
  i2cBus.registerDevice(LCD1602_ADDR, lcd1602Controller);

  statusLabel.textContent = 'Simulation time: ';

  // Hook to PORTB register
  runner.portB.addListener((value) => {
    // Port B starts at pin 8 to 13
    if (feedLed) {
      // None optimized
      if (hasLEDsOnPortB) {
        hasLEDsOnPortB = false;
        updateLEDs(value, 8);
      }
    }

    // Speaker
    if (feedBuzzer) {
      runner.speaker.feed(value & (1 << 0));
      buzzer.hasSignal = ((value & 0x01) == 1) ? true: false;
    }
  });

  // Hook to PORTC register
  runner.portC.addListener((value) => {
    // Analog input pins (A0-A5)
    if (feedLed) {
      // None optimized
      if (hasLEDsOnPortC) {
        hasLEDsOnPortC = false;
        updateLEDs(value, 0);
      }
    }
  });

  // Hook to PORTD register
  runner.portD.addListener((value) => {
    // Port D starts at pin 0 to 7
    if (feedLed) {
      // None optimized
      if (hasLEDsOnPortD) {
        hasLEDsOnPortD = false;
        updateLEDs(value, 0);
      }
    }

    // Feed the NeoPixel Matrix
    if (feedNeoPixel) {
      matrixController.feedValue(runner.portD.pinState(matrixPin), cpuNanos());
    }

    // Feed the 7 segment
    if (feed7Segment) {
      updateSegment(value)
    }
  });

  // Connect to Serial port
  runner.usart.onByteTransmit = (value: number) => {
    runnerOutputText.textContent += String.fromCharCode(value);
    runnerOutputText.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  // Connect to SPI
  runner.spi.onTransfer = (value: number) => {
    runnerOutputText.textContent += "SPI: 0x" + value.toString(16) + "\n";
    return value;
  };

  runner.execute((cpu) => {
    const time = formatTime(cpu.cycles / runner.frequency);
    const speed = (cpuPerf.update() * 100).toFixed(0);
    const millis = performance.now();

    if (feedNeoPixel) {
      const pixels = matrixController.update(cpuNanos());
      if (pixels) {
        // Update NeoPixel matrix
        redrawMatrix(pixels);
      }
    }

    if (feedSsd1306) {
      const frame = ssd1306Controller.update();
      // Update SSD1306
      ssd1306Controller.toImageData(ssd1306.imageData);
      ssd1306.redraw();
    }

    if (feedLcd1602) {
      const lcd = lcd1602Controller.update();
      // Check component
      if (lcd) {
        // Update LCD1602
        lcd1602.blink = lcd.blink;
        lcd1602.cursor = lcd.cursor;
        lcd1602.cursorX = lcd.cursorX;
        lcd1602.cursorY = lcd.cursorY;
        lcd1602.characters = lcd.characters;
        lcd1602.backlight = lcd.backlight;

        // Check custom character
        if (lcd.cgramUpdated) {
          const font = lcd1602.font.slice(0);
          const cgramChars = lcd.cgram.slice(0, 0x40);

          // Set character
          font.set(cgramChars, 0);
          font.set(cgramChars, 0x40);

          // Get character
          lcd1602.font = font;
        }
      }
    }

    statusLabelTimer.textContent = `${time}`;

    if ((millis - previousMillis) > 200) {
      // Update status
      previousMillis = millis;
      statusLabelSpeed.textContent = padLeft(speed, '0', 3) + '%';
    }
  });
}

async function compileAndRun() {

  storeUserSnippet();

  // Disable buttons
  compileButton.setAttribute('disabled', '1');
  runButton.setAttribute('disabled', '1');

  clearOutput();

  try {
    statusLabel.textContent = 'Compiling...';
    statusLabelTimer.textContent = '00:00.000';
    statusLabelSpeed.textContent = '0%';

    const result = await buildHex(ed.getEditor().getValue(),
      ed.getProjectFiles(), ed.getProjectBoard(), ed.getDebug());

    if (result.hex) {
      // Set project hex filename
      ed.setProjectHex(ed.getProjectPath(), ed.getProjectName('.hex'));

      // Save hex
      fs.writeFile(ed.getProjectHex(), result.hex, function (err) {
          if (err) return console.log(err)
      });

      stopButton.removeAttribute('disabled');

      clearLeds();
      executeProgram(result.hex);
    }

    // Check result error
    if (result.stderr != undefined || result.stdout != undefined) {
      runnerOutputText.textContent = result.stderr || result.stdout;
    }
  } catch (err) {
    runnerOutputText.textContent += err + "\n";
  } finally {
    compileButton.removeAttribute('disabled');
    runButton.removeAttribute('disabled');
  }
}

function storeUserSnippet() {
  EditorHistoryUtil.clearSnippet();
  EditorHistoryUtil.storeSnippet(ed.getEditor().getValue());
}

function onlyRun() {
  fs.readFile(ed.getProjectHex(), 'utf8', function(err, data) {
    if (err) {
      runnerOutputText.textContent += err + "\n";
    }

    if (data) {
      stopButton.removeAttribute('disabled');
      runButton.setAttribute('disabled', '1');

      clearLeds();
      executeProgram(data);
    }
  });
}

function stopCode() {
  stopButton.setAttribute('disabled', '1');
  compileButton.removeAttribute('disabled');
  runButton.removeAttribute('disabled');

  if (runner) {
    runner.stop();
    runner = null;

    // Turn off the LEDs
    clearLeds();

    // Turn off the 7 segment
    clearSegment();

     // Turn off the LCD1602
    clearLcd();

    // Turn off the NeoPixel Matrix
    clearMatrix();

    // Turn off speaker
    buzzer.hasSignal = false;
    statusLabel.textContent = 'Stop simulation: ';
  }
}

function serialKeyPress(event: any) {
  // Ckeck Enter
  if (event.charCode == 13) {
    serialTransmit();
  }
}

function serialTransmit() {
  // Serial transmit
  if (runner) {
    runner.serialWrite(serialInput.value + "\r\n");
    serialInput.value = "";
  } else {
    runnerOutputText.textContent += "Warning: AVR is not running!\n";
  }
}

function redrawMatrix(pixels: any) {
  for (let row = 0; row < matrix.rows; row++) {
    for (let col = 0; col < matrix.cols; col++) {
      const value = pixels[row * matrix.cols + col];

      const b = value & 0xff;
      const r = (value >> 8) & 0xff;
      const g = (value >> 16) & 0xff;

      // Canvas update
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      context.fillRect(col * pixSize, row * pixSize, pixSize, pixSize);

      // NeoPixel update
      matrix.setPixel(row, col, {
        b: (value & 0xff) / 255,
        r: ((value >> 8) & 0xff) / 255,
        g: ((value >> 16) & 0xff) / 255
      });
    }
  }
}

function clearMatrix() {
  for (let row = 0; row < matrix.rows; row++) {
    for (let col = 0; col < matrix.cols; col++) {
      const value = 0;

      const b = value & 0xff;
      const r = (value >> 8) & 0xff;
      const g = (value >> 16) & 0xff;

      // Canvas update
      context.fillStyle = `rgb(${r}, ${g}, ${b})`;
      context.fillRect(col * pixSize, row * pixSize, pixSize, pixSize);

      // NeoPixel update
      matrix.setPixel(row, col, {
        b: (value & 0xff) / 255,
        r: ((value >> 8) & 0xff) / 255,
        g: ((value >> 16) & 0xff) / 255
      });
    }
  }
}

function clearLeds() {
  leds.forEach(function(led) {
    const pin = parseInt(led.getAttribute("pin"), 10);
    led.value = false;
  });
}

function updateLEDs(value: number, startPin: number) {
  leds.forEach(function(led) {
    const pin = parseInt(led.getAttribute("pin"), 10);
    // Check pin
    if ((pin >= startPin) && (pin <= startPin + 8)) {
      // Checks in portB
      if (startPin == 8)
        hasLEDsOnPortB = true;

      // Checks in portC&D
      if (startPin == 0) {
        hasLEDsOnPortC = true;
        hasLEDsOnPortD = true;
      }

      const bit = 1 << (pin - startPin);

      // Set LED
      led.value = value & bit ? true : false;
    }
  });
}

function updateSegment(value: number) {
  // Set segment values
  segment.values = [
    value & (1 << 0),
    value & (1 << 1),
    value & (1 << 2),
    value & (1 << 3),
    value & (1 << 4),
    value & (1 << 5),
    value & (1 << 6),
    value & (1 << 7)
  ];
}

function clearSegment() {
  // Turn off the 7 segment
  segment.values = [0, 0, 0, 0, 0, 0, 0, 0];
}

function clearLcd() {
  // Set backlight off
  lcd1602.characters.fill(32);
  lcd1602.backlight = false;
  lcd1602.blink = false;
  lcd1602.cursor = false;
}

function clearOutput() {
  runnerOutputText.textContent = '';
}

function loadHex() {
  fileInput.click();
}

function changeFileInput() {
  let file = fileInput.files[0];

  if (file.name.match(/\.(hex)$/)) {
    // Set project hex filename
    ed.setProjectHex(file.path, '');
    runnerOutputText.textContent += "Load HEX: " + file.path + "\n";
  } else {
    runnerOutputText.textContent += "File not supported, .hex files only!\n";
  }
}

function printChars(value: string) {
  return [...value].map(char => char.charCodeAt(0));
}

function padLeft(text: string, padChar: string, size: number): string {
  return (String(padChar).repeat(size) + text).substr((size * -1), size);
}
