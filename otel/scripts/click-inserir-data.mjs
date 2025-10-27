#!/usr/bin/env node

/**
 * Script específico para abrir múltiplas instâncias do Puppeteer
 * e clicar continuamente no botão "addTask" do app
 * disponível em http://localhost:8080/.
 *
 * Ajuste as constantes em CONFIG caso precise alterar o comportamento.
 */

import puppeteer from 'puppeteer';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = {
  url: 'http://localhost:8080/',
  // O botão já possui data-testid='add-item' no app.
  selector: "button[data-testid='add-item']",
  durationMs: 5 * 60_000, // 5 minutos
  intervalMs: 250, // 0.25s entre cliques
  instances: 3, // quantas janelas do navegador abrir em paralelo
  waitTimeoutMs: 30_000, // até 30 segundos para o botão aparecer
  warmupMs: 5_000, // aguarda 5s após carregamento da página antes de começar a clicar
  headless: false, // mostre as janelas (altere para true para rodar escondido)
};

async function runInstance(instanceId, shouldAbort) {
  const browser = await puppeteer.launch({ headless: CONFIG.headless ? 'new' : false });
  const page = await browser.newPage();

  try {
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2' });

    if (CONFIG.warmupMs > 0) {
      await delay(CONFIG.warmupMs);
    }

    const endTimestamp = Date.now() + CONFIG.durationMs;
    let clickCount = 0;

    while (Date.now() < endTimestamp) {
      if (shouldAbort()) {
        return { instanceId, clickCount };
      }
      await page.waitForSelector(CONFIG.selector, {
        visible: true,
        timeout: CONFIG.waitTimeoutMs,
      });
      await page.click(CONFIG.selector);
      clickCount += 1;

      if (CONFIG.intervalMs > 0) {
        await delay(CONFIG.intervalMs);
      }
    }

    return { instanceId, clickCount };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('Iniciando clicker específico para "addTask":');
  Object.entries(CONFIG).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });

  let aborted = false;
  const abortHandler = () => {
    console.warn('\nSinal de abort recebido. Aguardando o encerramento dos navegadores...');
    aborted = true;
  };
  process.once('SIGINT', abortHandler);
  process.once('SIGTERM', abortHandler);

  try {
    const tasks = Array.from({ length: CONFIG.instances }, (_, idx) =>
      runInstance(idx + 1, () => aborted),
    );

    const results = await Promise.allSettled(tasks);

    let totalClicks = 0;
    let successfulInstances = 0;
    let hasFailures = false;

    results.forEach((result, idx) => {
      const label = `Instância ${idx + 1}`;
      if (result.status === 'fulfilled') {
        const { clickCount } = result.value;
        console.log(`${label}: ${clickCount} clique(s)`);
        totalClicks += clickCount;
        successfulInstances += 1;
      } else {
        hasFailures = true;
        console.error(`${label} falhou:`, result.reason);
      }
    });

    if (successfulInstances > 0) {
      console.log(`Cliques totais: ${totalClicks}`);
    }

    if (hasFailures) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Erro inesperado:', error);
    process.exitCode = 1;
  }
}

main();
