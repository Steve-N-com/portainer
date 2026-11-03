angular.module('portainer.docker').controller('SwarmVisualizerController', [
  '$q',
  '$http',
  '$scope',
  '$document',
  '$interval',
  'NodeService',
  'ServiceService',
  'TaskService',
  'Notifications',
  'LocalStorage',
  function ($q, $http, $scope, $document, $interval, NodeService, ServiceService, TaskService, Notifications, LocalStorage) {
    $scope.state = {
      ShowInformationPanel: true,
      DisplayOnlyRunningTasks: false,
      DisplayNodeLabels: false,
      refreshRate: '5',
      prometheusUrl: '',
      prometheusNodeLabel: 'swarm_node',
      metricsErrors: [],
    };

    $scope.handleChangeDisplayOnlyRunningTasks = function handleChangeDisplayOnlyRunningTasks(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayOnlyRunningTasks = enabled;
        $scope.changeDisplayOnlyRunningTasks();
      });
    };

    $scope.handleChangeDisplayNodeLabels = function handleChangeDisplayNodeLabels(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayNodeLabels = enabled;
        $scope.changeDisplayNodeLabels();
      });
    };

    $scope.$on('$destroy', function () {
      stopRepeater();
    });

    $scope.changeShowInformationPanel = function (value) {
      $scope.state.ShowInformationPanel = value;
      LocalStorage.storeSwarmVisualizerSettings('show_info_panel', value);
    };

    $scope.changeDisplayOnlyRunningTasks = function () {
      var value = $scope.state.DisplayOnlyRunningTasks;
      LocalStorage.storeSwarmVisualizerSettings('display_only_running_tasks', value);
    };

    $scope.changeDisplayNodeLabels = function () {
      var value = $scope.state.DisplayNodeLabels;
      LocalStorage.storeSwarmVisualizerSettings('display_node_labels', value);
    };

    $scope.savePrometheusSettings = function () {
      $scope.state.prometheusUrl = ($scope.state.prometheusUrl || '').trim().replace(/\/$/, '');
      $scope.state.prometheusNodeLabel = ($scope.state.prometheusNodeLabel || 'swarm_node').trim() || 'swarm_node';
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test($scope.state.prometheusNodeLabel)) {
        $scope.state.prometheusNodeLabel = 'swarm_node';
      }
      LocalStorage.storeSwarmVisualizerSettings('prometheus_url', $scope.state.prometheusUrl);
      LocalStorage.storeSwarmVisualizerSettings('prometheus_node_label', $scope.state.prometheusNodeLabel);
      refreshNodeMetrics($scope.nodes || []);
    };

    function promLabelValue(value) {
      return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }

    function queryPrometheus(query) {
      return $http.get($scope.state.prometheusUrl + '/api/v1/query', { params: { query: query } }).then(function (response) {
        if (!response.data || response.data.status !== 'success') {
          throw new Error(response.data && response.data.error || 'Prometheus returned an unsuccessful response');
        }
        var result = response.data.data && response.data.data.result;
        if (!result || !result.length || !result[0].value) return null;
        var value = Number(result[0].value[1]);
        return isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
      });
    }

    // Keep metric queries independent: a missing metric or a failed Prometheus
    // request must not prevent the other gauges from being updated.
    function reportMetricIssue(metricName, nodeName, message, error) {
      var description = nodeName + ': ' + metricName + ' - ' + message;
      var existing = $scope.state.metricsErrors || [];
      if (!existing.some(function (item) { return item === description; })) {
        existing.push(description);
      }
      $scope.state.metricsErrors = existing;
      if (window.console && window.console.error) {
        window.console.error('[Swarm visualizer] ' + description, error || '');
      }
    }

    function queryNodeMetric(query, metricName, nodeName) {
      return queryPrometheus(query).then(function (value) {
        if (value === null) {
          var hint = metricName === 'network'
            ? 'Prometheus returned no matching time series. Check that node_network_receive_bytes_total, node_network_transmit_bytes_total and node_network_speed_bytes are scraped for this node, and that the interface speed is greater than zero.'
            : 'Prometheus returned no matching time series. Check the node label and whether the required Node Exporter metric is being scraped.';
          reportMetricIssue(metricName, nodeName, hint);
        }
        return value;
      }).catch(function (error) {
        // AngularJS $http rejections are response objects, not Error instances.
        // Include the Prometheus API body/status so query and proxy errors are visible.
        var message = error && error.message;
        if (!message && error && error.data) {
          if (typeof error.data === 'string') {
            message = error.data;
          } else {
            message = error.data.error || error.data.message;
          }
        }
        if (error && error.status) {
          message = (message ? message + ' ' : '') + '(HTTP ' + error.status + (error.statusText ? ' ' + error.statusText : '') + ')';
        }
        if (!message && error && error.statusText) message = error.statusText;
        if (!message) message = 'Prometheus request failed (no response details; check browser network/console)';
        reportMetricIssue(metricName, nodeName, message, error);
        return null;
      });
    }

    function refreshNodeMetrics(nodes) {
      var url = $scope.state.prometheusUrl;
      if (!url || !nodes || !nodes.length) {
        nodes && nodes.forEach(function (node) { node.Metrics = null; });
        $scope.state.metricsErrors = [];
        return $q.when();
      }
      $scope.state.metricsErrors = [];
      var label = $scope.state.prometheusNodeLabel || 'swarm_node';
      var requests = [];
      nodes.forEach(function (node) {
        var nodeName = node.Hostname || node.Name;
        if (!nodeName) return;
        var selector = label + '="' + promLabelValue(nodeName) + '"';
        var cpuQuery = '100 * (1 - avg(rate(node_cpu_seconds_total{' + selector + ',mode="idle"}[5m])))';
        var memoryQuery = '100 * (1 - (node_memory_MemAvailable_bytes{' + selector + '} / node_memory_MemTotal_bytes{' + selector + '}))';
        // Disk busy time is reported as a ratio (0-1) by Node Exporter.
        var diskQuery = '100 * max(rate(node_disk_io_time_seconds_total{' + selector + ',device!~"^(loop|ram|fd|sr|zram).*"}[5m]))';
        // Use the fullest real filesystem, excluding pseudo and container filesystems.
        var storageQuery = '100 * max(1 - (node_filesystem_avail_bytes{' + selector + ',fstype!~"^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|mqueue|nsfs|overlay|proc|pstore|rpc_pipefs|securityfs|squashfs|sysfs|tmpfs|tracefs)$",mountpoint!~"^/(run|var/lib/docker/.+|var/lib/containerd/.+)"} / node_filesystem_size_bytes{' + selector + ',fstype!~"^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|mqueue|nsfs|overlay|proc|pstore|rpc_pipefs|securityfs|squashfs|sysfs|tmpfs|tracefs)$",mountpoint!~"^/(run|var/lib/docker/.+|var/lib/containerd/.+)"}))';
        // Calculate receive and transmit separately: rate() drops __name__, so a
        // combined metric-name selector can produce duplicate labelsets.
        // Add a direction label before combining the two vectors, then take the
        // busiest direction across interfaces for this node.
        var networkDevices = ',device!~"^(lo|docker.*|br-.*|veth.*|virbr.*|cni.*|flannel.*|weave.*|vxlan.*)$"';
        var networkSpeedQuery = 'max by (device,' + label + ') (node_network_speed_bytes{' + selector + networkDevices + '} > 0)';
        var receiveNetworkQuery = 'max by (device,' + label + ') (rate(node_network_receive_bytes_total{' + selector + networkDevices + '}[5m])) / on(device,' + label + ') ' + networkSpeedQuery;
        var transmitNetworkQuery = 'max by (device,' + label + ') (rate(node_network_transmit_bytes_total{' + selector + networkDevices + '}[5m])) / on(device,' + label + ') ' + networkSpeedQuery;
        var networkQuery = '100 * max by (' + label + ') (label_replace((' + receiveNetworkQuery + '), "direction", "receive", "device", ".*") or label_replace((' + transmitNetworkQuery + '), "direction", "transmit", "device", ".*"))';
        requests.push($q.all([
          queryNodeMetric(cpuQuery, 'CPU', nodeName),
          queryNodeMetric(memoryQuery, 'memory', nodeName),
          queryNodeMetric(diskQuery, 'disk I/O', nodeName),
          queryNodeMetric(storageQuery, 'storage', nodeName),
          queryNodeMetric(networkQuery, 'network', nodeName)
        ]).then(function (values) {
          if (!node.Metrics) node.Metrics = {};
          node.Metrics.cpu = values[0];
          node.Metrics.memory = values[1];
          node.Metrics.disk = values[2];
          node.Metrics.storage = values[3];
          node.Metrics.network = values[4];
        }));
      });
      return $q.all(requests);
    }

    $scope.changeUpdateRepeater = function () {
      stopRepeater();
      setUpdateRepeater();
      $('#refreshRateChange').show();
      $('#refreshRateChange').fadeOut(1500);
      LocalStorage.storeSwarmVisualizerSettings('refresh_rate', $scope.state.refreshRate);
    };

    function stopRepeater() {
      var repeater = $scope.repeater;
      if (angular.isDefined(repeater)) {
        $interval.cancel(repeater);
      }
    }

    function getClusterData() {
      return $q.all({
        nodes: NodeService.nodes(),
        services: ServiceService.services(),
        tasks: TaskService.tasks(),
      });
    }

    // Reconcile API results into the existing arrays and objects. Keeping stable
    // references allows ngRepeat to update changed bindings without recreating
    // every node and task element on each polling cycle.
    function syncCollection(existing, incoming, updateItem) {
      var existingById = Object.create(null);
      existing.forEach(function (item) {
        if (item && item.Id !== undefined && item.Id !== null) {
          existingById[String(item.Id)] = item;
        }
      });

      var nextItems = [];
      (incoming || []).forEach(function (incomingItem) {
        var id = incomingItem && incomingItem.Id;
        var existingItem = id !== undefined && id !== null ? existingById[String(id)] : null;
        if (existingItem) {
          updateItem(existingItem, incomingItem);
          nextItems.push(existingItem);
        } else {
          nextItems.push(incomingItem);
        }
      });

      existing.length = 0;
      Array.prototype.push.apply(existing, nextItems);
      return existing;
    }

    function updateNode(existingNode, incomingNode) {
      var tasks = existingNode.Tasks;
      var metrics = existingNode.Metrics;
      angular.extend(existingNode, incomingNode);
      existingNode.Tasks = tasks || [];
      existingNode.Metrics = metrics;
    }

    function updateVisualizer(data) {
      $scope.nodes = syncCollection($scope.nodes || [], data.nodes, updateNode);
      $scope.services = syncCollection($scope.services || [], data.services, function (existing, incoming) {
        angular.extend(existing, incoming);
      });
      $scope.tasks = syncCollection($scope.tasks || [], data.tasks, function (existing, incoming) {
        angular.extend(existing, incoming);
      });

      prepareVisualizerData($scope.nodes, $scope.services, $scope.tasks);
      refreshNodeMetrics($scope.nodes);
    }

    function setUpdateRepeater() {
      var refreshRate = $scope.state.refreshRate;
      $scope.repeater = $interval(function () {
        getClusterData()
          .then(updateVisualizer)
          .catch(function error(err) {
            stopRepeater();
            Notifications.error('Failure', err, 'Unable to retrieve cluster information');
          });
      }, refreshRate * 1000);
    }

    function assignServiceInfo(services, tasks) {
      for (var i = 0; i < services.length; i++) {
        var service = services[i];

        for (var j = 0; j < tasks.length; j++) {
          var task = tasks[j];

          if (task.ServiceId === service.Id) {
            task.ServiceName = service.Name;
          }
        }
      }
    }

    function assignTasksToNode(nodes, tasks) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var nodeTasks = [];

        for (var j = 0; j < tasks.length; j++) {
          var task = tasks[j];

          if (task.NodeId === node.Id) {
            nodeTasks.push(task);
          }
        }

        node.Tasks = syncCollection(node.Tasks || [], nodeTasks, function (existing, incoming) {
          // Tasks are already reconciled in $scope.tasks; retain their identity.
          if (existing !== incoming) {
            angular.extend(existing, incoming);
          }
        });
      }
    }

    function prepareVisualizerData(nodes, services, tasks) {
      assignServiceInfo(services, tasks);
      assignTasksToNode(nodes, tasks);

      if (!$scope.visualizerData) {
        $scope.visualizerData = { nodes: nodes };
      } else {
        $scope.visualizerData.nodes = nodes;
      }
    }

    function loadState() {
      var showInfoPanel = LocalStorage.getSwarmVisualizerSettings('show_info_panel');
      if (showInfoPanel !== undefined && showInfoPanel !== null) $scope.state.ShowInformationPanel = showInfoPanel;

      var displayOnlyRunningTasks = LocalStorage.getSwarmVisualizerSettings('display_only_running_tasks');
      if (displayOnlyRunningTasks !== undefined && displayOnlyRunningTasks !== null) $scope.state.DisplayOnlyRunningTasks = displayOnlyRunningTasks;

      var displayNodeLabels = LocalStorage.getSwarmVisualizerSettings('display_node_labels');
      if (displayNodeLabels !== undefined && displayNodeLabels !== null) $scope.state.DisplayNodeLabels = displayNodeLabels;

      var refreshRate = LocalStorage.getSwarmVisualizerSettings('refresh_rate');
      if (refreshRate !== undefined && refreshRate !== null) $scope.state.refreshRate = refreshRate;
      var prometheusUrl = LocalStorage.getSwarmVisualizerSettings('prometheus_url');
      if (prometheusUrl !== undefined && prometheusUrl !== null) $scope.state.prometheusUrl = prometheusUrl;
      var prometheusNodeLabel = LocalStorage.getSwarmVisualizerSettings('prometheus_node_label');
      if (prometheusNodeLabel !== undefined && prometheusNodeLabel !== null) $scope.state.prometheusNodeLabel = prometheusNodeLabel;
    }

    function initView() {
      getClusterData()
        .then(function success(data) {
          updateVisualizer(data);
          setUpdateRepeater();
        })
        .catch(function error(err) {
          Notifications.error('Failure', err, 'Unable to initialize cluster visualizer');
        });

      loadState();
    }

    initView();
  },
]);
