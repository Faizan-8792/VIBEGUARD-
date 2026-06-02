import { analyzeHealth } from '../engines/health-analyzer.js';
import { emitJson } from '../utils/json-output.js';
import { header, scoreBar, keyValue, divider, summaryLine, statusIcon, brand } from '../utils/ui.js';
import type { CommandContext } from '../context.js';

export async function runDoctor(ctx: CommandContext): Promise<void> {
  const { config, logger, projectRoot, options } = ctx;

  logger.startSpinner('Analyzing project health...');

  const result = await analyzeHealth(config, projectRoot, (percent, label) => {
    logger.updateSpinner(`[${percent}%] ${label}`);
  });

  logger.stopSpinner(true);

  if (options.json) {
    emitJson({
      summary: result.summary,
      issues: result.issues,
      warnings: result.warnings,
    });
  } else {
    const output: string[] = [];

    output.push(header('Project Health Report', '🏥'));
    output.push('');

    // Overall score prominently
    const overallColor = result.summary.projectHealth >= 80 ? 'success' : result.summary.projectHealth >= 50 ? 'warning' : 'danger';
    const overallIcon = overallColor === 'success' ? '✔' : overallColor === 'warning' ? '⚠' : '✖';
    output.push(`  ${brand[overallColor].bold(overallIcon)} ${brand[overallColor].bold(`Overall Health: ${result.summary.projectHealth}/100`)}`);
    output.push('');

    // Sub-scores with bars
    output.push(keyValue('Security', scoreBar(result.summary.security)));
    output.push(keyValue('Dead Code', scoreBar(result.summary.deadCode)));
    output.push(keyValue('Architecture', scoreBar(result.summary.architecture)));
    output.push(keyValue('Context Efficiency', scoreBar(result.summary.contextEfficiency)));
    output.push('');

    // Issues summary
    if (result.issues.length > 0) {
      output.push(divider());
      output.push('');
      const counts = {
        critical: result.issues.filter((i) => i.severity === 'critical').length,
        high: result.issues.filter((i) => i.severity === 'high').length,
        medium: result.issues.filter((i) => i.severity === 'medium').length,
        low: result.issues.filter((i) => i.severity === 'low').length,
      };
      output.push(summaryLine([
        { label: 'Critical', value: counts.critical, color: counts.critical > 0 ? 'danger' : 'muted' },
        { label: 'High', value: counts.high, color: counts.high > 0 ? 'warning' : 'muted' },
        { label: 'Medium', value: counts.medium, color: 'muted' },
        { label: 'Low', value: counts.low, color: 'muted' },
      ]));
    }

    // Warnings
    if (result.warnings.length > 0) {
      output.push('');
      for (const w of result.warnings) {
        output.push(`  ${statusIcon('warning')} ${brand.muted(w)}`);
      }
    }

    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}
