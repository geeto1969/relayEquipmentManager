﻿import { logger } from "../logger/Logger";
import { I2cController, cont, I2cBus, I2cDevice, I2cDeviceFeed } from "../boards/Controller";
import { setTimeout, clearTimeout } from "timers";
import { AnalogDevices } from "../devices/AnalogDevices";
import { webApp } from "../web/Server";
import { PromisifiedBus } from "i2c-bus";
import { i2cDeviceFactory } from "./i2cFactory";
import { connBroker, ServerConnection } from "../connections/Bindings";
import * as extend from "extend";
import { Buffer } from "buffer";
export class i2cController {
    public i2cBus;
    public buses: i2cBus[] = [];
    constructor() {
        try {
            console.log(process.platform);
            switch (process.platform) {
                case 'linux':
                    this.i2cBus = require('i2c-bus');
                    break;
                default:
                    this.i2cBus = new mockI2c();
                    break;
            }
        } catch (err) { console.log(err); }
    }
    public async initAsync(i2c: I2cController) {
        try {
            logger.info(`Initializing i2c Interface`);
            for (let i = 0; i < i2c.buses.length; i++) {
                let bus = i2c.buses.getItemByIndex(i);
                if (!bus.isActive) continue;
                let ibus = new i2cBus();
                await ibus.initAsync(bus);
                this.buses.push(ibus);
            }
        } catch (err) { logger.error(err); }
    }
    public async closeAsync() {
        for (let i = 0; i < this.buses.length; i++) {
            await this.buses[i].closeAsync();
        }
        this.buses.length = 0;
    }
    public async resetAsync(i2c) {
        try {
            await this.closeAsync();
            await this.initAsync(i2c);
        } catch (err) { logger.error(err); }
    }

}
export class i2cBus {
    //private _opts;
    private _i2cBus: PromisifiedBus | mockI2cBus;
    public devices: i2cDeviceBase[] = [];
    public busNumber: number;
    constructor() { }
    public async scanBus(start: number = 0x03, end: number = 0x77): Promise<{ address: number, name: string, product: number, manufacturer: number }[]> {
        try {
            logger.info(`Scanning i2c Bus #${this.busNumber}`);
            let addrs = await this._i2cBus.scan(start, end);
            let devs = [];
            let cdev = { address: 0, manufacturer: 0, product: 0, name: 'Unknown' };
            for (let i = 0; i < addrs.length; i++) {
                try {
                    logger.info(`Found I2C device at address: 0x${addrs[i].toString(16)}`);
                    cdev = { address: addrs[i], manufacturer: 0, product: 0, name: 'Unkown' };
                    devs.push(cdev);
                    let o = await this._i2cBus.deviceId(addrs[i]);
                }
                catch (err) {
                    logger.silly(`Error Executing deviceId for address ${cdev.address}: ${err}`);
                }
            }
            return Promise.resolve(devs);
        }
        catch (err) { logger.error(`Error Scanning i2c Bus #${this.busNumber}: ${err}`); }
    }
    public async initAsync(bus: I2cBus) {
        try {
            this.busNumber = bus.busNumber;
            logger.info(`Initializing i2c Bus #${bus.busNumber}`);
            this._i2cBus = await i2c.i2cBus.openPromisified(bus.busNumber, {});
            bus.functions = await this._i2cBus.i2cFuncs();
            bus.addresses = await this.scanBus();
            //let device = await i2cDeviceBase.factoryCreate(this, {} as I2cDevice);
            for (let i = 0; i < bus.devices.length; i++) {
                let dev = bus.devices.getItemByIndex(i);
                try {
                    let dt = dev.getDeviceType();
                    let device = await i2cDeviceBase.factoryCreate(this, dev);
                }
                catch (err) { logger.error(err); }
            }


            logger.info(`i2c Bus #${bus.busNumber} Initialized`);
        } catch (err) { logger.error(err); }
    }
    public async readByte(addr: number, cmd: number): Promise<number> {
        try {
            let byte = await this._i2cBus.readByte(addr, cmd);
            return Promise.resolve(byte);
        }
        catch (err) { logger.error(err); }
    }
    public async writeCommand(address: number, command: string | number | Buffer, length?: number): Promise<number> {
        try {
            let ret = { bytesWritten: -1 };
            if (typeof command === 'string') {
                if (typeof length === 'undefined') length = command.length;
                ret = await this._i2cBus.i2cWrite(address, command.length, Buffer.from(command));
            }
            else if (typeof command === 'number') {
                if (typeof length === 'undefined') length = 1;
                let buffer = Buffer.allocUnsafe(length);
                switch (length) {
                    case 1:
                        buffer.writeUInt8(command, 0);
                        break;
                    case 2:
                        buffer.writeInt16BE(command, 0);
                        break;
                    case 4:
                        buffer.writeInt32BE(command, 0);
                        break;
                    default:
                        return Promise.reject(new Error(`Error writing I2c ${command}.  Improper length specified for number.`));
                        break;
                }
                ret = await this._i2cBus.i2cWrite(address, length, buffer);
            }
            else if (typeof command === 'object' && Buffer.isBuffer(command)) {
                if (typeof length === 'undefined') length = command.length;
                ret = await this._i2cBus.i2cWrite(address, length, command);
            }
            else {
                let err = new Error(`Error writing I2c ${command}.  Invalid type for command.`);
                logger.error(err);
                return Promise.reject(err);
            }
            if (ret.bytesWritten !== length) {
                let err = new Error(`Error writing I2c ${command}.  Mismatch on bytes written ${ret.bytesWritten}.`);
                logger.error(err);
                return Promise.reject(err);
            }
            return Promise.resolve(ret.bytesWritten);
        }
        catch (err) { logger.error(err); return Promise.resolve(0); }
    }
    public async read(address: number, length: number): Promise<{ bytesRead: number, buffer: Buffer }> {
        try {
            let buffer: Buffer = Buffer.alloc(length);
            let ret = await this._i2cBus.i2cRead(address, length, buffer);
            return Promise.resolve(ret);
        }
        catch (err) { logger.error(err); }
    }
    public async resetAsync(bus) {
        try {
            await this.closeAsync();
            await this.initAsync(bus);
        } catch (err) { logger.error(err); }
    }
    public async closeAsync() {
        try {
            for (let i = 0; i < this.devices.length; i++) {
                await this.devices[i].closeAsync();
            }
            this.devices.length = 0;
            await this._i2cBus.close();
            logger.info(`Closed i2c Bus #${this.busNumber}`);
        } catch (err) { logger.error(err); }
    }
}
//export class i2cDevice {
//    private _readCommand: Function;
//    private _getValue: Function;
//    private _convertValue: Function;
//    public maxRawValue: number;
//    private _ct;
//    public busNumber: number;
//    public channel: number;
//    public refVoltage: number;
//    private rawValue: number;
//    private convertedValue: number;
//    private units: string;
//    public device;
//    public precision: number;
//    private _i2cDevice;
//    public speedHz: number;
//    private _timerRead: NodeJS.Timeout;
//    public feeds: i2cFeed[] = [];
//    public lastVal: number;
//    public deviceOptions: any;
//    public sampling: number = 1;
//    public samples: number[] = [];
//    public isOpen: boolean = false;
//    constructor(ct, dev: I2cDevice, refVoltage) {
//        this._ct = ct;
//        this.channel = dev.id - 1;
//        this._readCommand = new Function('channel', ct.readChannel);
//        this._getValue = new Function('buffer', ct.getValue);
//        this.device = cont.analogDevices.find(elem => elem.id === dev.deviceId);
//        this._convertValue = new Function('maps', 'opts', 'value', this.device.convertValue);
//        this.deviceOptions = extend(true, {}, dev.options);
//        this.maxRawValue = Math.pow(2, this._ct.bits) - 1;
//        this.refVoltage = refVoltage;
//        this.precision = this.device.precision;
//        this.sampling = dev.sampling || 1;
//        for (let i = 0; i < dev.feeds.length; i++) {
//            let f = dev.feeds.getItemByIndex(i);
//            if (f.isActive) this.feeds.push(new i2cFeed(f));
//        }
//    }
//    public openAsync(i2cBus, opts) {
//        return new Promise((resolve, reject) => {
//            this.busNumber = opts.busNumber;
//            try {
//                logger.info(`Attempting to open i2c Bus #${opts.busNumber} Channel #${this.channel}`);
//                this._i2cDevice = i2cBus.open(opts.busNumber || 0, this.channel, err => {
//                    if (err) { logger.error(err); reject(err) }
//                    else {
//                        this.isOpen = true;
//                        setTimeout(() => { this.readAsync(); }, 500);
//                        resolve();
//                    }
//                });
//                logger.info(`Opened i2c Bus #${opts.busNumber} Channel #${this.channel}`);
//            } catch (err) { logger.error(err); }
//        });
//    }
//    private convertValue(val): number {
//        let ratio = val !== 0 ? ((this.maxRawValue / val - 1)) : 0;
//        let lval;
//        let vout = (this.refVoltage * val) / this.maxRawValue;
//        switch (this.device.input.toLowerCase()) {
//            case 'ohms':
//                let ohms = (this.deviceOptions.resistance || this.device.resistance);
//                let resistance = ohms * val / (this.maxRawValue - val);

//                // Below is Steinhart/Hart equation.
//                //let A = 0.001129148
//                //let B = 0.000234125
//                //let C = 0.0000000876741;
//                //let Rth = resistance;
//                //let tk = (1 / (A + (B * Math.log(resistance)) + (C * Math.pow((Math.log(resistance)), 3))));
//                //let tc = tk - 273.15;
//                //let tf = tc * 9 / 5 + 32;
//                // lval = tf;



//                //console.log({
//                //    vcc: this.refVoltage, vout: vout, ohms: ohms, resistance: resistance, max: this.maxRawValue,
//                //    tk: tk,
//                //    tc: tc,
//                //    tf: tf
//                //});
//                //lval = tf;

//                lval = this._convertValue(AnalogDevices.maps, this.deviceOptions, resistance); 
//                break;
//            case 'v':
//            case 'volts':
//                lval = this._convertValue(AnalogDevices.maps, this.deviceOptions, this.refVoltage * ratio);
//                break;
//            case 'mv':
//            case 'millivolts':
//                lval = this._convertValue(AnalogDevices.maps, this.deviceOptions, (this.refVoltage * 1000) * ratio);
//                break;
//            default:
//                lval = val;
//                break;
//        }
//        return this.setPrecision(lval);
//    }
//    private setPrecision(val: number): number {
//        if (typeof this.precision !== 'number') return val;
//        let pow = Math.pow(10, this.precision);
//        return Math.round(val * pow) / pow;
//    }
//    public readAsync(): Promise<number> {
//        return new Promise<number>((resolve, reject) => {
//            if (!this.isOpen) return reject(new Error(`i2c Channel is closed and cannot be read`));
//            if (this._timerRead) clearTimeout(this._timerRead);
//            let readBuff = this._readCommand(this.channel);
//            let b: Buffer = Buffer.from([0, 0, 0]);
//            let message = [{
//                byteLength: readBuff.byteLength,
//                sendBuffer: readBuff,
//                receiveBuffer: Buffer.alloc(readBuff.byteLength),
//                speedHz: this.speedHz || 2000
//            }];
//            //if (this.channel === 1) console.log(readBuff);
//            this._i2cDevice.transfer(message, (err, reading) => {
//                if (err) { logger.error(err); reject(err); }
//                else {
//                    try {
//                        let rawVal = this.rawValue = this._getValue(message[0].receiveBuffer);
//                        if (this.sampling > 1) {
//                            this.samples.push(rawVal);
//                            if (this.samples.length >= this.sampling) {
//                                let mid = Math.floor(this.samples.length / 2);
//                                let nums = [...this.samples].sort((a, b) => a - b);
//                                rawVal = this.samples.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid] / 2);
//                                this.samples.length = 0;
//                            }
//                            else {
//                                this._timerRead = setTimeout(() => { this.readAsync(); }, 500);
//                                resolve(rawVal);
//                                return;
//                            }
//                        }
//                        //logger.info(`Raw:${this.rawValue} b(1):${message[0].receiveBuffer[1]} b(2):${message[0].receiveBuffer[2]} Speed: ${ message[0].speedHz }`);
//                        this.convertedValue = this.convertValue(rawVal);
//                        // Now we need to trigger the values to all the cannel feeds.
//                        if (typeof this.lastVal === 'undefined' || this.lastVal !== this.convertedValue) {
//                            webApp.emitToClients('i2cChannel', { bus: this.busNumber, channel: this.channel, raw: rawVal, converted: this.convertedValue, buffer: message[0].receiveBuffer });
//                            for (let i = 0; i < this.feeds.length; i++) this.feeds[i].value = this.convertedValue;
//                        }
//                        this._timerRead = setTimeout(() => { this.readAsync(); }, 500);
//                    }
//                    catch (err) { logger.error(err); reject(err); }
//                    resolve(reading);
//                }
//            });
//        });
//    }
//    public closeAsync(): Promise<void> {
//        return new Promise<void>((resolve, reject) => {
//            if (typeof this._timerRead !== 'undefined') clearTimeout(this._timerRead);
//            for (let i = 0; i < this.feeds.length; i++) this.feeds[i].closeAsync();
//            this._timerRead = null;
//            this.isOpen = false;
//            console.log(`Closing i2c Channel ${this.busNumber} ${this.channel}`);
//            this._i2cDevice.close(err => {
//                if (err) reject(err);
//                resolve();
//            });
//        });
//    }
//}
class i2cFeed {
    public server: ServerConnection;
    public frequency: number;
    public eventName: string;
    public property: string;
    public lastSent: number;
    public value: number;
    public changesOnly: boolean;
    private _timerSend: NodeJS.Timeout;
    public translatePayload: Function;
    constructor(feed: I2cDeviceFeed) {
        this.server = connBroker.findServer(feed.connectionId);
        this.frequency = feed.frequency * 1000;
        this.eventName = feed.eventName;
        this.property = feed.property;
        this.changesOnly = feed.changesOnly;
        this._timerSend = setTimeout(() => this.send(), this.frequency);
        if (typeof feed.payloadExpression !== 'undefined' && feed.payloadExpression.length > 0)
            this.translatePayload = new Function('feed', 'value', feed.payloadExpression);
    }
    public send() {
        if (this._timerSend) clearTimeout(this._timerSend);
        if (typeof this.value !== 'undefined') {
            if (!this.changesOnly || this.lastSent !== this.value) {
                this.server.send({
                    eventName: this.eventName,
                    property: this.property,
                    value: typeof this.translatePayload === 'function' ? this.translatePayload(this, this.value) : this.value
                });
                this.lastSent = this.value;
            }
        }
        this._timerSend = setTimeout(() => this.send(), this.frequency);
    }
    public closeAsync() {
        if (typeof this._timerSend !== 'undefined') clearTimeout(this._timerSend);
        this._timerSend = null;
    }
}
const i2cBits = {
    I2C_FUNC_I2C: 0x00000001,
    I2C_FUNC_10BIT_ADDR: 0x00000002,
    I2C_FUNC_PROTOCOL_MANGLING: 0x00000004,
    I2C_FUNC_SMBUS_PEC: 0x00000008,
    I2C_FUNC_SMBUS_BLOCK_PROC_CALL: 0x00008000,
    I2C_FUNC_SMBUS_QUICK: 0x00010000,
    I2C_FUNC_SMBUS_READ_BYTE: 0x00020000,
    I2C_FUNC_SMBUS_WRITE_BYTE: 0x00040000,
    I2C_FUNC_SMBUS_READ_BYTE_DATA: 0x00080000,
    I2C_FUNC_SMBUS_WRITE_BYTE_DATA: 0x00100000,
    I2C_FUNC_SMBUS_READ_WORD_DATA: 0x00200000,
    I2C_FUNC_SMBUS_WRITE_WORD_DATA: 0x00400000,
    I2C_FUNC_SMBUS_PROC_CALL: 0x00800000,
    I2C_FUNC_SMBUS_READ_BLOCK_DATA: 0x01000000,
    I2C_FUNC_SMBUS_WRITE_BLOCK_DATA: 0x02000000,
    I2C_FUNC_SMBUS_READ_I2C_BLOCK: 0x04000000,
    I2C_FUNC_SMBUS_WRITE_I2C_BLOCK: 0x08000000
}

class mockI2cFuncs {
    public i2c: boolean = false;
    public tenBitAddr: boolean = false;
    public protocolMangling: boolean = false;
    public smbusPec: boolean = false;
    public smbusBlockProcCall: boolean = false;
    public smbusQuick: boolean = false;
    public smbusReceiveByte: boolean = false;
    public smbusSendByte: boolean = false;
    public smbusReadByte: boolean = false;
    public smbusWriteByte: boolean = false;
    public smbusReadWord: boolean = false;
    public smbusWriteWord: boolean = false;
    public smbusProcCall: boolean = false;
    public smbusReadBlock: boolean = false;
    public smbusWriteBlock: boolean = false;
    public smbusReadI2cBlock: boolean = false;
    public smbusWriteI2cBlock: boolean = false;
    constructor(i2cFuncBits) {
        this.i2c = !!(i2cFuncBits & i2cBits.I2C_FUNC_I2C);
        this.tenBitAddr = !!(i2cFuncBits & i2cBits.I2C_FUNC_10BIT_ADDR);
        this.protocolMangling = !!(i2cFuncBits & i2cBits.I2C_FUNC_PROTOCOL_MANGLING);
        this.smbusPec = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_PEC);
        this.smbusBlockProcCall = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_BLOCK_PROC_CALL);
        this.smbusQuick = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_QUICK);
        this.smbusReceiveByte = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_READ_BYTE);
        this.smbusSendByte = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_WRITE_BYTE);
        this.smbusReadByte = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_READ_BYTE_DATA);
        this.smbusWriteByte = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_WRITE_BYTE_DATA);
        this.smbusReadWord = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_READ_WORD_DATA);
        this.smbusWriteWord = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_WRITE_WORD_DATA);
        this.smbusProcCall = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_PROC_CALL);
        this.smbusReadBlock = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_READ_BLOCK_DATA);
        this.smbusWriteBlock = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_WRITE_BLOCK_DATA);
        this.smbusReadI2cBlock = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_READ_I2C_BLOCK);
        this.smbusWriteI2cBlock = !!(i2cFuncBits & i2cBits.I2C_FUNC_SMBUS_WRITE_I2C_BLOCK);
    }
}
class mockI2c {
    public openPromisified(busNumber, options): Promise<mockI2cBus> {
        return new Promise<mockI2cBus>((resolve, reject) => {
            setTimeout(() => { resolve(new mockI2cBus(busNumber, options)); }, 100);
        });
    }
}
class mockI2cBus {
    public busNumber: number;
    public options;
    private isOpen: boolean;
    private funcs = new mockI2cFuncs(3);
    constructor(busNumber, options) { this.busNumber = busNumber; this.options = options; }
    public bus() { return {}; }
    public close(): Promise<void> { return Promise.resolve(); }
    public i2cFuncs(): Promise<mockI2cFuncs> { return Promise.resolve(this.funcs); }
    public scan(startAddr: number = 3, endAddr: number = 115): Promise<number[]> { return Promise.resolve([15 + this.busNumber, 98 + this.busNumber]); }
    public deviceId(addr: number): Promise<{ manufacturer: number, product: number, name: string }> { return Promise.resolve({ manufacturer: 0, product: 0, name: 'Mock product' }); }
    public i2cRead(addr: number, length: number, buffer: Buffer): Promise<{ bytesRead: number, buffer: Buffer }> { return Promise.resolve({ bytesRead: length, buffer: buffer }); }
    public i2cWrite(addr: number, length: number, buffer: Buffer): Promise<{ bytesWritten: number, buffer: Buffer }> { return Promise.resolve({ bytesWritten: length, buffer: buffer }); }
    public readByte(addr: number, cmd: number): Promise<number> { return Promise.resolve(0); }
    public readWord(addr: number, cmd: number): Promise<number> { return Promise.resolve(0); }
    public readI2cBlock(addr: number, cmd: number, length: number, buffer: Buffer): Promise<{ bytesRead: number, buffer: Buffer }> { return Promise.resolve({ bytesRead: length, buffer: buffer }); }
    public receiveByte(addr: number): Promise<number> { return Promise.resolve(0); }
    public sendByte(addr: number, byte: number): Promise<void> { return Promise.resolve(); }
    public writeByte(addr: number, cmd: number, byte: number): Promise<void> { return Promise.resolve(); }
    public writeWord(add: number, cmd: number, word: number): Promise<void> { return Promise.resolve(); }
    public writeQuick(add: number, bit: number): Promise<void> { return Promise.resolve(); }
    public writeI2cBlock(addr: number, cmd: number, length: number, buffer: Buffer): Promise<{ bytesWritten: number, buffer: Buffer }> { return Promise.resolve({ bytesWritten: length, buffer: buffer }); }
}
export class i2cDeviceBase {
    public static async factoryCreate(i2c, dev: I2cDevice): Promise<i2cDeviceBase> {
        try {
            let dt = dev.getDeviceType();
            if (typeof dt === 'undefined') return Promise.reject(new Error(`Cannot initialize I2c device id${dev.id} on Bus ${i2c.busNumber}: Device type not found ${dev.typeId}`));
            let d = i2cDeviceFactory.createDevice(dt.deviceClass, i2c, dev);
            if (typeof d !== 'undefined') {
                if (await d.initAsync(dt)) logger.info(`Device ${dt.name} initialized for i2c bus #${i2c.busNumber} address ${dev.address}`);
            }
            return Promise.resolve(d);
        }
        catch (err) { logger.error(err); }
    }
    constructor(i2c, dev: I2cDevice) {
        this.i2c = i2c;
        this.device = dev;
    }
    public readable: boolean = false;
    public writable: boolean = false;
    public i2c;
    public device: I2cDevice;
    public async closeAsync() { return Promise.resolve(); }
    public async initAsync(deviceType: any): Promise<boolean> { return Promise.resolve(true); }
}

export let i2c = new i2cController();