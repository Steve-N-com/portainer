angular.module('portainer.docker').controller('SwarmVisualizerController', [
  '$q',
  '$scope',
  '$document',
  '$interval',
  'NodeService',
  'ServiceService',
  'TaskService',
  'ContainerService',
  'EndpointProvider',
  'Notifications',
  'LocalStorage',
  function ($q, $scope, $document, $interval, NodeService, ServiceService, TaskService, ContainerService, EndpointProvider, Notifications, LocalStorage) {
    $scope.Math = Math;

    $scope.formatMemoryBytes = function (bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return 'Unavailable';
      var divisor = bytes >= 1073741824 ? 1073741824 : 1048576;
      var unit = divisor === 1073741824 ? ' GiB' : ' MiB';
      return (bytes / divisor).toFixed(2) + unit;
    };

    $scope.state = {
      ShowInformationPanel: true,
      DisplayOnlyRunningTasks: false,
      DisplayNodeLabels: false,
      DisplayStandaloneContainers: true,
      DisplayResourceAllocations: true,
      DisplayActualResourceUsage: true,
      refreshRate: '5',
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

    $scope.handleChangeDisplayStandaloneContainers = function handleChangeDisplayStandaloneContainers(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayStandaloneContainers = enabled;
        $scope.changeDisplayStandaloneContainers();
      });
    };

    $scope.handleChangeDisplayResourceAllocations = function handleChangeDisplayResourceAllocations(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayResourceAllocations = enabled;
        $scope.changeDisplayResourceAllocations();
      });
    };

    $scope.handleChangeDisplayActualResourceUsage = function handleChangeDisplayActualResourceUsage(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayActualResourceUsage = enabled;
        $scope.changeDisplayActualResourceUsage();
        if (enabled && $scope.state.DisplayResourceAllocations && $scope.nodes) {
          refreshNodeResourceUsage($scope.nodes);
        }
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

    $scope.changeDisplayStandaloneContainers = function () {
      var value = $scope.state.DisplayStandaloneContainers;
      LocalStorage.storeSwarmVisualizerSettings('display_standalone_containers', value);
    };

    $scope.changeDisplayResourceAllocations = function () {
      var value = $scope.state.DisplayResourceAllocations;
      LocalStorage.storeSwarmVisualizerSettings('display_resource_allocations', value);
    };

    $scope.changeDisplayActualResourceUsage = function () {
      var value = $scope.state.DisplayActualResourceUsage;
      LocalStorage.storeSwarmVisualizerSettings('display_actual_resource_usage', value);
    };

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
        containers: ContainerService.containers(EndpointProvider.endpointID(), { all: true }),
      });
    }

    function updateVisualizer(data) {
      var previousNodes = $scope.nodes || [];
      $scope.nodes = data.nodes;
      $scope.services = data.services;
      $scope.tasks = data.tasks;
      $scope.containers = data.containers || [];
      prepareVisualizerData(data.nodes, data.services, data.tasks, $scope.containers, previousNodes);
      if ($scope.state.DisplayResourceAllocations && $scope.state.DisplayActualResourceUsage) {
        refreshNodeResourceUsage(data.nodes);
      }
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

    function assignTasksToNode(nodes, tasks, previousNodes) {
      var previousUsageByTask = new Map();
      previousNodes.forEach(function (node) {
        (node.Tasks || []).forEach(function (task) {
          if (task.Id && task.ResourceUsage) {
            previousUsageByTask.set(task.Id, task.ResourceUsage);
          }
        });
      });

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        node.Tasks = [];

        for (var j = 0; j < tasks.length; j++) {
          var task = tasks[j];

          if (task.NodeId === node.Id) {
            task.ResourceUsage = previousUsageByTask.get(task.Id) || task.ResourceUsage || { cpuCores: null, memoryBytes: null };
            node.Tasks.push(task);
          }
        }
      }
    }

    function assignStandaloneContainersToNode(nodes, containers, tasks) {
      nodes.forEach(function (node) {
        node.Containers = [];
      });

      // Use the task container IDs as the authoritative exclusion list. Swarm
      // container labels are not consistently present in every Agent response.
      var taskContainerIds = (tasks || [])
        .map(function (task) {
          return task.Status && task.Status.ContainerStatus && task.Status.ContainerStatus.ContainerID;
        })
        .filter(Boolean);

      containers.forEach(function (container) {
        var labels = container.Labels || {};

        // Swarm service containers are already represented by their Swarm tasks.
        if (labels['com.docker.swarm.service.id'] || labels['com.docker.swarm.task.id'] || taskContainerIds.indexOf(container.Id) !== -1) {
          return;
        }

        var nodeName = (container.NodeName || '').toLowerCase();
        if (!nodeName) {
          return;
        }

        var node = nodes.find(function (candidate) {
          return [candidate.Hostname, candidate.Name].some(function (name) {
            return name && name.toLowerCase() === nodeName;
          });
        });
        if (node) {
          node.Containers.push(container);
        }
      });
    }

    function isAllocatedTask(task) {
      var state = task.Status && task.Status.State;
      return task.DesiredState !== 'shutdown' && ['complete', 'failed', 'rejected', 'orphaned', 'remove', 'shutdown'].indexOf(state) === -1;
    }

    function sumTaskResources(tasks, resource, field) {
      return tasks.reduce(function (total, task) {
        var resources = task.Spec && task.Spec.Resources;
        var value = resources && resources[resource] && resources[resource][field];
        return total + (typeof value === 'number' && isFinite(value) ? value : 0);
      }, 0);
    }

    function countTasksWithoutResource(tasks, resource, field) {
      return tasks.filter(function (task) {
        var resources = task.Spec && task.Spec.Resources;
        return !(resources && resources[resource] && typeof resources[resource][field] === 'number');
      }).length;
    }

    function allocationForNode(node, capacity, field) {
      var allocatedTasks = node.Tasks.filter(isAllocatedTask);
      var reserved = sumTaskResources(allocatedTasks, 'Reservations', field);
      var limited = sumTaskResources(allocatedTasks, 'Limits', field);
      var tasksWithoutLimit = countTasksWithoutResource(allocatedTasks, 'Limits', field);
      var safeCapacity = typeof capacity === 'number' && capacity > 0 ? capacity : 0;

      return {
        capacity: safeCapacity,
        reserved: reserved,
        limited: limited,
        reservedPercent: safeCapacity ? Math.min((reserved / safeCapacity) * 100, 100) : 0,
        limitedPercent: safeCapacity ? Math.min((limited / safeCapacity) * 100, 100) : 0,
        reservedOverCapacity: safeCapacity > 0 && reserved > safeCapacity,
        limitedOverCapacity: safeCapacity > 0 && limited > safeCapacity,
        tasksWithoutLimit: tasksWithoutLimit,
        hasCapacity: safeCapacity > 0,
      };
    }

    var resourceUsageRequestInProgress = false;

    function refreshNodeResourceUsage(nodes) {
      if (resourceUsageRequestInProgress) return $q.when();
      resourceUsageRequestInProgress = true;
      var runningTasks = [];
      nodes.forEach(function (node) {
        (node.Tasks || []).forEach(function (task) {
          if (task.Status && task.Status.State === 'running' && task.ContainerId) {
            runningTasks.push({ node: node, task: task });
          }
        });
      });

      var usageByNode = new Map();
      return $q.all(runningTasks.map(function (item) {
        return ContainerService.containerStats(item.task.ContainerId, { nodeName: item.node.Hostname })
          .then(function (stats) {
            var taskCpuCores = null;
            var cpuDelta = stats.CurrentCPUTotalUsage - stats.PreviousCPUTotalUsage;
            var systemDelta = stats.CurrentCPUSystemUsage - stats.PreviousCPUSystemUsage;
            if (systemDelta > 0 && cpuDelta >= 0) {
              taskCpuCores = (cpuDelta / systemDelta) * stats.CPUCores;
            }
            var taskMemoryBytes = typeof stats.MemoryUsage === 'number' && isFinite(stats.MemoryUsage) ? stats.MemoryUsage : null;
            var previousUsage = item.task.ResourceUsage || {};
            item.task.ResourceUsage = {
              cpuCores: taskCpuCores !== null ? taskCpuCores : previousUsage.cpuCores,
              memoryBytes: taskMemoryBytes !== null ? taskMemoryBytes : previousUsage.memoryBytes,
            };

            var usage = usageByNode.get(item.node.Id) || { cpuCores: 0, memoryBytes: 0, cpuSamples: 0, memorySamples: 0 };
            if (taskCpuCores !== null) {
              usage.cpuCores += taskCpuCores;
              usage.cpuSamples += 1;
            }
            if (taskMemoryBytes !== null) {
              usage.memoryBytes += taskMemoryBytes;
              usage.memorySamples += 1;
            }
            usageByNode.set(item.node.Id, usage);
          })
          .catch(function () {
            // A task can disappear or move while statistics are being collected.
          });
      })).then(function () {
        nodes.forEach(function (node) {
          var usage = usageByNode.get(node.Id);
          var allocation = node.ResourceAllocation;
          if (!allocation) return;

          allocation.cpu.actual = usage && usage.cpuSamples ? usage.cpuCores : null;
          allocation.cpu.actualPercent = usage && usage.cpuSamples && allocation.cpu.capacity
            ? Math.min((usage.cpuCores * 1000000000 / allocation.cpu.capacity) * 100, 100)
            : 0;
          allocation.memory.actual = usage && usage.memorySamples ? usage.memoryBytes : null;
          allocation.memory.actualPercent = usage && usage.memorySamples && allocation.memory.capacity
            ? Math.min((usage.memoryBytes / allocation.memory.capacity) * 100, 100)
            : 0;
        });
        if (!$scope.$destroyed) $scope.$evalAsync();
      }).finally(function () {
        resourceUsageRequestInProgress = false;
      });
    }

    function assignNodeResourceAllocations(nodes, previousNodes) {
      var previousAllocations = new Map();
      previousNodes.forEach(function (node) {
        if (node.ResourceAllocation) {
          previousAllocations.set(node.Id, node.ResourceAllocation);
        }
      });

      nodes.forEach(function (node) {
        var previous = previousAllocations.get(node.Id);
        node.ResourceAllocation = {
          cpu: allocationForNode(node, node.CPUs, 'NanoCPUs'),
          memory: allocationForNode(node, node.Memory, 'MemoryBytes'),
        };

        if (previous) {
          ['cpu', 'memory'].forEach(function (resource) {
            node.ResourceAllocation[resource].actual = previous[resource].actual;
            node.ResourceAllocation[resource].actualPercent = previous[resource].actualPercent;
          });
        }
      });
    }

    function prepareVisualizerData(nodes, services, tasks, containers, previousNodes) {
      var visualizerData = {};

      assignServiceInfo(services, tasks);
      assignTasksToNode(nodes, tasks, previousNodes || []);
      assignStandaloneContainersToNode(nodes, containers || [], tasks || []);
      $scope.hasStandaloneContainers = nodes.some(function (node) {
        return node.Containers.length > 0;
      });
      assignNodeResourceAllocations(nodes, previousNodes || []);

      visualizerData.nodes = nodes;
      $scope.visualizerData = visualizerData;
    }

    function loadState() {
      var showInfoPanel = LocalStorage.getSwarmVisualizerSettings('show_info_panel');
      if (showInfoPanel !== undefined && showInfoPanel !== null) $scope.state.ShowInformationPanel = showInfoPanel;

      var displayOnlyRunningTasks = LocalStorage.getSwarmVisualizerSettings('display_only_running_tasks');
      if (displayOnlyRunningTasks !== undefined && displayOnlyRunningTasks !== null) $scope.state.DisplayOnlyRunningTasks = displayOnlyRunningTasks;

      var displayNodeLabels = LocalStorage.getSwarmVisualizerSettings('display_node_labels');
      if (displayNodeLabels !== undefined && displayNodeLabels !== null) $scope.state.DisplayNodeLabels = displayNodeLabels;

      var displayStandaloneContainers = LocalStorage.getSwarmVisualizerSettings('display_standalone_containers');
      if (displayStandaloneContainers !== undefined && displayStandaloneContainers !== null) $scope.state.DisplayStandaloneContainers = displayStandaloneContainers;

      var displayResourceAllocations = LocalStorage.getSwarmVisualizerSettings('display_resource_allocations');
      if (displayResourceAllocations !== undefined && displayResourceAllocations !== null) $scope.state.DisplayResourceAllocations = displayResourceAllocations;

      var displayActualResourceUsage = LocalStorage.getSwarmVisualizerSettings('display_actual_resource_usage');
      if (displayActualResourceUsage !== undefined && displayActualResourceUsage !== null) $scope.state.DisplayActualResourceUsage = displayActualResourceUsage;

      var refreshRate = LocalStorage.getSwarmVisualizerSettings('refresh_rate');
      if (refreshRate !== undefined && refreshRate !== null) $scope.state.refreshRate = refreshRate;
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
